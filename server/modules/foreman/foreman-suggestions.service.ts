import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Lifecycle of a Foreman suggestion, as Foreman reports it. */
export const FOREMAN_SUGGESTION_STATUSES = ['pending', 'sent', 'edited', 'dismissed', 'superseded', 'expired'] as const;
export type ForemanSuggestionStatus = (typeof FOREMAN_SUGGESTION_STATUSES)[number];

/** What the user did with a suggestion; the same words Foreman's feedback endpoint takes. */
export const FOREMAN_FEEDBACK_ACTIONS = ['sent', 'edited', 'dismissed'] as const;
export type ForemanFeedbackAction = (typeof FOREMAN_FEEDBACK_ACTIONS)[number];

/**
 * A suggestion as Foreman sends it. cloudcli reads only the fields below to validate and route it;
 * everything else Foreman includes (attempts, trace ids, costs) is passed through to the UI untouched.
 */
export type ForemanSuggestion = {
  id: string;
  sessionId: string;
  status: ForemanSuggestionStatus;
  decision: {
    /** What the card shows (after Foreman's policy). */
    decision: { action: string; reason: string; [key: string]: unknown };
    model?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** The WebSocket frame that tells open chats about a new or changed suggestion. */
export type ForemanSuggestionEvent = {
  kind: 'foreman_suggestion';
  sessionId: string;
  suggestion: ForemanSuggestion;
  timestamp: string;
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const SUGGESTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_FINAL_TEXT_LENGTH = 200_000;
const DEFAULT_FOREMAN_URL = 'http://127.0.0.1:4111';
const FOREMAN_TIMEOUT_MS = 5000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function invalid(message: string, code = 'INVALID_REQUEST'): AppError {
  return new AppError(message, { code, statusCode: 400 });
}

/**
 * Validates a suggestion pushed by Foreman before it reaches any browser. The routes sit behind the bridge token, so
 * this is a shape check (a buggy push must not put garbage on every open socket), not an authorisation step.
 */
// Consumed by the bridge route POST /suggestions and by the broadcaster tests.
export function parseForemanSuggestion(value: unknown): ForemanSuggestion {
  const suggestion = asRecord(value);
  if (!suggestion) {
    throw invalid('suggestion is required and must be an object.');
  }
  if (typeof suggestion.id !== 'string' || !SUGGESTION_ID_PATTERN.test(suggestion.id)) {
    throw invalid('suggestion.id is not a valid suggestion id.');
  }
  if (typeof suggestion.sessionId !== 'string' || !SESSION_ID_PATTERN.test(suggestion.sessionId)) {
    throw invalid('suggestion.sessionId is not a valid session id.', 'INVALID_SESSION_ID');
  }
  if (typeof suggestion.status !== 'string' || !(FOREMAN_SUGGESTION_STATUSES as readonly string[]).includes(suggestion.status)) {
    throw invalid(`suggestion.status must be one of: ${FOREMAN_SUGGESTION_STATUSES.join(', ')}.`);
  }
  const decision = asRecord(suggestion.decision);
  const shown = asRecord(decision?.decision);
  if (!decision || !shown || typeof shown.action !== 'string' || !shown.action || typeof shown.reason !== 'string') {
    throw invalid('suggestion.decision.decision must carry an action and a reason.');
  }
  return suggestion as ForemanSuggestion;
}

type SuggestionBroadcasterDependencies = {
  /** The open chat sockets (cloudcli's `connectedClients`). */
  clients: () => Iterable<RealtimeClientConnection>;
  /** The readyState value of an open socket. */
  openState: number;
  now?: () => Date;
};

/**
 * Sends a suggestion to every open chat socket as a `foreman_suggestion` frame.
 *
 * The sockets do not tell the server which session they are showing, so every open chat receives the frame and the
 * client keeps only the ones for the session it is viewing (the same way `session_upserted` works). A send that
 * throws on one dead socket never stops the others.
 */
// Consumed by foreman.module.ts, which hands it to the bridge router for POST /suggestions.
export function createSuggestionBroadcaster(dependencies: SuggestionBroadcasterDependencies) {
  const now = dependencies.now ?? (() => new Date());
  return {
    /** Returns how many sockets the frame was sent to. */
    broadcast(suggestion: ForemanSuggestion): number {
      const frame: ForemanSuggestionEvent = {
        kind: 'foreman_suggestion',
        sessionId: suggestion.sessionId,
        suggestion,
        timestamp: now().toISOString(),
      };
      const payload = JSON.stringify(frame);
      let delivered = 0;
      for (const client of dependencies.clients()) {
        if (client.readyState !== dependencies.openState) {
          continue;
        }
        try {
          client.send(payload);
          delivered += 1;
        } catch {
          // A socket that fails mid-send is closing; the heartbeat removes it.
        }
      }
      return delivered;
    },
  };
}

type ForemanSuggestionsClientDependencies = {
  tokenFile: string;
  /** Foreman's origin. Defaults to `FOREMAN_URL`, then the origin of `FOREMAN_EVENTS_URL`, then Foreman's local address. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Consumed by the Foreman tab client (foreman-tab.service.ts), which calls Foreman the same way.
export function resolveForemanBaseUrl(explicit: string | undefined): string {
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const fromEnv = process.env.FOREMAN_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, '');
  }
  const eventsUrl = process.env.FOREMAN_EVENTS_URL?.trim();
  if (eventsUrl) {
    try {
      return new URL(eventsUrl).origin;
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_FOREMAN_URL;
}

/**
 * cloudcli's calls to Foreman on behalf of the signed-in user: fetch the pending suggestion for a session and report
 * what the user did with one. The bridge token is added here, server-side, and never reaches the browser.
 */
// Consumed by the user-facing suggestions router, which maps its results onto HTTP responses.
export function createForemanSuggestionsClient(dependencies: ForemanSuggestionsClientDependencies) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? FOREMAN_TIMEOUT_MS;

  async function call(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const token = await readBridgeToken(dependencies.tokenFile);
    if (!token) {
      throw new AppError('The Foreman bridge is disabled: no bridge token is configured.', {
        code: 'FOREMAN_BRIDGE_DISABLED',
        statusCode: 503,
      });
    }
    let response: Response;
    try {
      response = await fetchImpl(`${resolveForemanBaseUrl(dependencies.baseUrl)}${pathAndQuery}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppError(`Foreman is not reachable: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'FOREMAN_UNAVAILABLE',
        statusCode: 502,
      });
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = asRecord(await response.json());
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  return {
    /** The pending suggestion for a session, or null. */
    async getPending(sessionId: string): Promise<ForemanSuggestion | null> {
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw invalid('Invalid session id.', 'INVALID_SESSION_ID');
      }
      const { status, json } = await call('GET', `/foreman/suggestions?sessionId=${encodeURIComponent(sessionId)}`);
      if (status !== 200) {
        throw new AppError('Foreman could not return the pending suggestion.', { code: 'FOREMAN_ERROR', statusCode: 502 });
      }
      const suggestion = json?.suggestion;
      return suggestion === null || suggestion === undefined ? null : parseForemanSuggestion(suggestion);
    },

    /** Records what the user did with a suggestion. Foreman answers once per suggestion (404 unknown, 409 already answered). */
    async sendFeedback(suggestionId: string, input: { action: ForemanFeedbackAction; finalText?: string }): Promise<Record<string, unknown>> {
      if (!SUGGESTION_ID_PATTERN.test(suggestionId)) {
        throw invalid('Invalid suggestion id.');
      }
      if (!(FOREMAN_FEEDBACK_ACTIONS as readonly string[]).includes(input.action)) {
        throw invalid(`action must be one of: ${FOREMAN_FEEDBACK_ACTIONS.join(', ')}.`);
      }
      if (input.finalText !== undefined && (typeof input.finalText !== 'string' || input.finalText.length > MAX_FINAL_TEXT_LENGTH)) {
        throw invalid(`finalText must be a string of at most ${MAX_FINAL_TEXT_LENGTH} characters.`);
      }
      const { status, json } = await call('POST', `/foreman/suggestions/${encodeURIComponent(suggestionId)}/feedback`, {
        action: input.action,
        ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
      });
      if (status === 200 && json) {
        return json;
      }
      if (status === 404) {
        throw new AppError('Suggestion not found.', { code: 'SUGGESTION_NOT_FOUND', statusCode: 404 });
      }
      if (status === 409) {
        throw new AppError('This suggestion has already been answered.', {
          code: 'SUGGESTION_NOT_PENDING',
          statusCode: 409,
          details: json?.suggestion ? { suggestion: json.suggestion } : undefined,
        });
      }
      if (status === 400) {
        throw invalid(typeof json?.error === 'string' ? json.error : 'Foreman rejected the feedback.');
      }
      throw new AppError('Foreman could not record the feedback.', { code: 'FOREMAN_ERROR', statusCode: 502 });
    },
  };
}

export type ForemanSuggestionsClient = ReturnType<typeof createForemanSuggestionsClient>;
export type ForemanSuggestionBroadcaster = ReturnType<typeof createSuggestionBroadcaster>;

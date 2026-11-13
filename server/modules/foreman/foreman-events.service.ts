import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import type {
  ClaudeRuntimeEvent,
  ForemanBilling,
  ForemanEvent,
} from '@/shared/types.js';
import { clipText, summarizeToolInput } from '@/shared/utils.js';

/** Model marker that bills a Claude session to the Anthropic API key (see claude-models.provider.ts). */
const API_KEY_MODEL_MARKER = '@api';

const DEFAULT_EVENTS_URL = 'http://127.0.0.1:4111/foreman/events';
const PUSH_TIMEOUT_MS = 2000;
const MAX_QUEUED_EVENTS = 200;
// A refusal can be reported twice (the refused assistant message and the structured
// `model_refusal_*` notice); one report per session within this window is enough.
const REFUSAL_DEDUPE_MS = 30_000;

const MAX_EXPLANATION_TEXT = 400;
const MAX_ERROR_TEXT = 500;
const MAX_PERMISSION_INPUT_TEXT = 200;
// A guarded prompt carries more of the call: Foreman re-judges it, and a long command must not hide its risky part.
const MAX_GUARDED_PERMISSION_INPUT_TEXT = 1000;

type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Splits a stored model value into the plain model and its billing mode. A model carrying the
 * `@api` marker runs on the API key; anything else (including no model) runs on the subscription.
 */
// Consumed by foreman-sessions.service.ts for listings and by foreman.module.ts for event context.
export function splitModelBilling(model: string | null | undefined): { model: string | null; billing: ForemanBilling } {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) {
    return { model: null, billing: 'subscription' };
  }
  if (trimmed.endsWith(API_KEY_MODEL_MARKER)) {
    return { model: trimmed.slice(0, -API_KEY_MODEL_MARKER.length), billing: 'api-key' };
  }
  return { model: trimmed, billing: 'subscription' };
}

/** Applies a billing mode to a plain model value: adds the `@api` marker for `api-key`, removes it otherwise. */
// Consumed by foreman-sessions.service.ts when starting sessions and switching models.
export function applyModelBilling(model: string, billing: ForemanBilling): string {
  const plain = splitModelBilling(model).model ?? model.trim();
  return billing === 'api-key' ? `${plain}${API_KEY_MODEL_MARKER}` : plain;
}

/** What the pusher knows about a session when it stamps an event (looked up fresh for every event). */
export type ForemanEventSessionContext = {
  billing: ForemanBilling | null;
  title: string | null;
  taskId?: string;
};

function refusalDetails(source: RecordValue | null): { category: string | null; explanation: string | null } {
  const category = asString(source?.api_refusal_category) ?? asString(source?.category);
  const explanation = asString(source?.api_refusal_explanation) ?? asString(source?.explanation);
  return {
    category,
    explanation: explanation ? clipText(explanation, MAX_EXPLANATION_TEXT) : null,
  };
}

function describeTurnResult(
  event: Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>,
  turnCostUsd: number | null,
): RecordValue {
  const message = event.message;
  const usage = asRecord(message.usage);
  const modelUsageKeys = Object.keys(asRecord(message.modelUsage) ?? {});
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === 'string').slice(0, 5)
    : [];
  return {
    // The model that answered; when the runtime did not see one, the only model the turn billed.
    model: event.model ?? (modelUsageKeys.length === 1 ? modelUsageKeys[0] : null),
    // Main-loop usage of this turn (subagent and compaction calls are not included).
    inputTokens: asNumber(usage?.input_tokens),
    outputTokens: asNumber(usage?.output_tokens),
    cacheReadTokens: asNumber(usage?.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage?.cache_creation_input_tokens),
    // This turn's cost: the change in the CLI's running total; null when the baseline is unknown.
    costUsd: turnCostUsd,
    durationMs: asNumber(message.duration_ms),
    numTurns: asNumber(message.num_turns),
    toolCalls: event.toolCalls,
    toolErrors: event.toolErrors,
    stopReason: asString(message.stop_reason),
    isError: message.is_error === true,
    // Additive context.
    totalCostUsd: asNumber(message.total_cost_usd),
    subtype: asString(message.subtype),
    terminalReason: asString(message.terminal_reason),
    errors: errors.map((entry) => clipText(entry, MAX_ERROR_TEXT)),
  };
}

/**
 * Translates one runtime observation into the event Foreman receives, or `null` when it is not
 * one Foreman cares about (unknown message subtypes, events without a session id).
 *
 * Pure: the timestamp, the session description and the turn's cost are passed in, so tests can
 * pin them.
 */
// Consumed by the event pusher below and by the events tests.
export function toForemanEvent(
  event: ClaudeRuntimeEvent,
  context: { now: Date; session: ForemanEventSessionContext; turnCostUsd: number | null },
): ForemanEvent | null {
  if (!event.sessionId) {
    return null;
  }

  // Shared by every event's data: what the supervisor needs to attribute it without a lookup.
  // A session with no row yet still reports the billing its own run declared.
  const common = {
    billing: context.session.billing ?? (event.kind === 'run_started' ? splitModelBilling(event.model).billing : null),
    title: context.session.title,
    ...(context.session.taskId ? { taskId: context.session.taskId } : {}),
  };
  const base = {
    sessionId: event.sessionId,
    projectPath: event.projectPath ?? '',
    ts: context.now.toISOString(),
  };

  switch (event.kind) {
    case 'run_started': {
      return {
        ...base,
        type: 'session_started',
        data: {
          ...common,
          resumed: event.resumed,
          model: splitModelBilling(event.model).model,
          permissionMode: event.permissionMode,
        },
      };
    }
    case 'run_ended':
      return { ...base, type: 'session_ended', data: { ...common, reason: event.reason } };
    case 'run_error':
      return { ...base, type: 'error', data: { ...common, source: 'run', message: clipText(event.message, MAX_ERROR_TEXT) } };
    case 'turn_result':
      return { ...base, type: 'turn_end', data: { ...common, ...describeTurnResult(event, context.turnCostUsd) } };
    case 'permission_request': {
      const guarded = event.guarded === true;
      return {
        ...base,
        type: 'permission_request',
        data: {
          ...common,
          requestId: event.requestId,
          toolName: event.toolName,
          input: summarizeToolInput(event.input, guarded ? MAX_GUARDED_PERMISSION_INPUT_TEXT : MAX_PERMISSION_INPUT_TEXT),
          // Only a call the session's guard judged risky: why, and that it is Foreman's to answer.
          ...(guarded ? { category: event.category ?? null, guarded: true } : {}),
        },
      };
    }
    case 'assistant_refusal': {
      const message = asRecord(event.message.message);
      return {
        ...base,
        type: 'refusal',
        data: {
          ...common,
          source: 'stop_reason',
          model: asString(message?.model),
          requestId: asString(event.message.request_id) ?? asString(event.message.requestId),
          messageId: asString(message?.id),
          ...refusalDetails(asRecord(message?.stop_details)),
        },
      };
    }
    case 'system_message': {
      const message = event.message;
      const subtype = asString(message.subtype);
      if (subtype === 'compact_boundary') {
        const metadata = asRecord(message.compact_metadata) ?? asRecord(message.compactMetadata);
        return {
          ...base,
          type: 'compact_boundary',
          data: {
            ...common,
            trigger: asString(metadata?.trigger),
            preTokens: asNumber(metadata?.pre_tokens ?? metadata?.preTokens),
            postTokens: asNumber(metadata?.post_tokens ?? metadata?.postTokens),
            durationMs: asNumber(metadata?.duration_ms ?? metadata?.durationMs),
          },
        };
      }
      if (subtype === 'model_refusal_fallback' || subtype === 'model_refusal_no_fallback') {
        return {
          ...base,
          type: 'refusal',
          data: {
            ...common,
            source: subtype,
            fallback: subtype === 'model_refusal_fallback',
            originalModel: asString(message.original_model),
            fallbackModel: asString(message.fallback_model),
            scope: asString(message.scope),
            requestId: asString(message.request_id),
            ...refusalDetails(message),
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Works out what each turn cost from the CLI's running cost total.
 *
 * The SDK's `total_cost_usd` is cumulative for the CLI process, and a resumed process continues
 * from the total its transcript saved. A turn's cost is therefore the change since the previous
 * result of the same session: known for a brand-new session (it starts at zero) and for any
 * session whose previous result this process has seen; unknown (null) for the first result after a
 * cloudcli restart or when the total went down (e.g. after `/clear`).
 */
// Consumed by the event pusher below, which asks it for every turn result.
export function createTurnCostTracker() {
  const lastTotals = new Map<string, number>();

  return {
    /** Feed every runtime event; for a `turn_result` it returns that turn's cost, otherwise null. */
    observe(event: ClaudeRuntimeEvent): number | null {
      if (!event.sessionId) {
        return null;
      }
      if (event.kind === 'run_started') {
        if (!event.resumed) {
          lastTotals.set(event.sessionId, 0);
        }
        return null;
      }
      if (event.kind !== 'turn_result') {
        return null;
      }

      const total = asNumber(event.message.total_cost_usd);
      if (total === null) {
        return null;
      }
      const previous = lastTotals.get(event.sessionId);
      lastTotals.set(event.sessionId, total);
      if (previous === undefined || total < previous) {
        return null;
      }
      return Math.round((total - previous) * 1e6) / 1e6;
    },
  };
}

/**
 * Tracks which sessions last ended in a failure, so the bridge can report the `error` status.
 *
 * Held in memory only: it covers this cloudcli process's lifetime, and a session leaves the
 * state as soon as it starts another run or finishes a turn cleanly.
 */
// Consumed by foreman.module.ts, which feeds it runtime events and reads it for session listings.
export function createRuntimeOutcomeTracker() {
  const failed = new Set<string>();

  return {
    observe(event: ClaudeRuntimeEvent): void {
      if (!event.sessionId) {
        return;
      }
      if (event.kind === 'run_started') {
        failed.delete(event.sessionId);
      } else if (event.kind === 'run_error') {
        failed.add(event.sessionId);
      } else if (event.kind === 'turn_result') {
        const isError = event.message.is_error === true || String(event.message.subtype ?? '').startsWith('error');
        if (isError) {
          failed.add(event.sessionId);
        } else {
          failed.delete(event.sessionId);
        }
      }
    },
    hasFailed(sessionId: string): boolean {
      return failed.has(sessionId);
    },
  };
}

type EventPusherDependencies = {
  /** Path of the bridge token file; no file means no push. */
  tokenFile: string;
  /** Describes a session for the event envelope (billing, title, task). Must not throw; failures are tolerated. */
  describeSession?: (sessionId: string) => ForemanEventSessionContext;
  /** Where events are POSTed. Defaults to `FOREMAN_EVENTS_URL`, then Foreman's local endpoint. */
  eventsUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxQueuedEvents?: number;
  now?: () => Date;
  /** Diagnostic sink; the pusher itself only ever reports failures here, at debug level. */
  debug?: (message: string) => void;
};

/**
 * Pushes runtime events to Foreman, fire-and-forget.
 *
 * `handle` never throws and never waits: it translates the event and appends it to a bounded
 * in-memory queue that a single background loop drains in order, one POST at a time, each with
 * a hard timeout. If Foreman is down, slow, or the token file is gone, the event is dropped and
 * a debug line is recorded — the Claude runtime never notices.
 */
// Consumed by foreman.module.ts, which subscribes it to the Claude runtime's event stream.
export function createForemanEventPusher(dependencies: EventPusherDependencies) {
  const eventsUrl = dependencies.eventsUrl ?? process.env.FOREMAN_EVENTS_URL ?? DEFAULT_EVENTS_URL;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? PUSH_TIMEOUT_MS;
  const maxQueued = dependencies.maxQueuedEvents ?? MAX_QUEUED_EVENTS;
  const now = dependencies.now ?? (() => new Date());
  const debug = dependencies.debug ?? (() => undefined);

  const queue: ForemanEvent[] = [];
  const lastRefusalAt = new Map<string, number>();
  const costs = createTurnCostTracker();
  let draining: Promise<void> | null = null;

  function describe(sessionId: string): ForemanEventSessionContext {
    try {
      return dependencies.describeSession?.(sessionId) ?? { billing: null, title: null };
    } catch (error) {
      debug(`foreman event session lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return { billing: null, title: null };
    }
  }

  async function deliver(event: ForemanEvent): Promise<void> {
    try {
      const token = await readBridgeToken(dependencies.tokenFile);
      if (!token) {
        debug(`foreman event ${event.type} skipped: bridge disabled (no token)`);
        return;
      }
      const response = await fetchImpl(eventsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The body is never read; releasing it lets the connection be reused or closed promptly.
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        debug(`foreman event ${event.type} rejected: HTTP ${response.status}`);
      }
    } catch (error) {
      debug(`foreman event ${event.type} not delivered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) {
        await deliver(next);
      }
    }
    draining = null;
  }

  return {
    /** Accepts one runtime event; safe to call from the runtime loop (synchronous, never throws). */
    handle(event: ClaudeRuntimeEvent): void {
      try {
        const turnCostUsd = costs.observe(event);
        const translated = toForemanEvent(event, {
          now: now(),
          session: event.sessionId ? describe(event.sessionId) : { billing: null, title: null },
          turnCostUsd,
        });
        if (!translated) {
          return;
        }

        if (translated.type === 'refusal') {
          const at = Date.parse(translated.ts);
          const previous = lastRefusalAt.get(translated.sessionId);
          if (previous !== undefined && at - previous < REFUSAL_DEDUPE_MS) {
            return;
          }
          lastRefusalAt.set(translated.sessionId, at);
        }

        if (queue.length >= maxQueued) {
          // Foreman is not keeping up; keep the newest events.
          queue.shift();
          debug('foreman event queue full: dropped the oldest event');
        }
        queue.push(translated);
        draining ??= drain();
      } catch (error) {
        debug(`foreman event dropped: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    /** Resolves when everything queued so far has been attempted. Used by tests. */
    async whenIdle(): Promise<void> {
      while (draining) {
        await draining;
      }
    },
  };
}

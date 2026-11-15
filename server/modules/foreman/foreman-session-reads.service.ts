import type { sessionsDb } from '@/modules/database/index.js';
import { splitModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import {
  buildSessionDigest,
  estimateContextFromTranscript,
  hasTurnStarts,
  locateTranscript,
  readTranscriptRows,
  type SessionDigestBody,
} from '@/modules/foreman/foreman-digest.service.js';
import type { ForemanSessionStateService, ForemanSessionStatus, ForemanSupervision } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanBilling, ForemanBridgeEvent, ForemanBridgeSessionStatus } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/** What `GET /sessions` (and the digest) report for one session. */
export type ForemanSessionSummary = {
  id: string;
  /** The Foreman task that started the session, when it was started with a `taskId`. */
  taskId: string | null;
  projectPath: string | null;
  title: string | null;
  /** Plain model (the `@api` / `@cap` billing marker is reported as `billing`). */
  model: string | null;
  billing: ForemanBilling;
  status: ForemanSessionStatus;
  /** The permission mode Foreman chose for the session (kept across restarts); null when it never chose one. */
  permissionMode: string | null;
  /** True when the session runs in a sandbox (every session the bridge starts does, a session handed over keeps the owner's settings). */
  sandboxed: boolean;
  /** Whether Foreman started the session, the owner handed it over, or Foreman no longer supervises it; null when it never did. */
  supervision: ForemanSupervision | null;
  /** True when a Claude process or an active run exists for the session right now. */
  live: boolean;
  lastActivity: string | null;
  /** Non-ambient background tasks (shells, monitors, agents) the live process last reported. */
  backgroundTasks: number;
};

/** The part of the SDK's context-usage report the bridge reads. */
// Consumed by foreman.module.ts (it narrows the runtime's loosely typed report to this) and the route tests.
export type LiveContextUsage = {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  model: string;
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
  categories: Array<{ name: string; tokens: number; kind: string }>;
};

/** What `GET /sessions/:id/context` reports. */
export type ForemanContextReport = {
  sessionId: string;
  /** `live` = measured by the running process; `transcript` = estimated from the last assistant usage. */
  source: 'live' | 'transcript' | 'unknown';
  model: string | null;
  usedTokens: number | null;
  /** The window the context is measured against (the CLI's compaction window when live). */
  windowTokens: number | null;
  /** The model's hard limit when it differs from the measuring window (live only). */
  rawWindowTokens: number | null;
  fraction: number | null;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean | null;
  /** Largest used categories of a live measurement. */
  categories: Array<{ name: string; tokens: number }>;
  measuredAt: string | null;
  note: string | null;
};

/** What the reads need from the rest of cloudcli, injected so they can be tested without a database, a websocket server or a Claude process. */
// Consumed by foreman.module.ts, which wires the production implementations, and by the route tests' world.
export type ForemanSessionReadsDependencies = {
  sessionsDb: Pick<typeof sessionsDb, 'getSessionById' | 'getRecentSessionsPage'>;
  runs: {
    isProcessing(sessionId: string): boolean;
    listRunningSessionIds(): string[];
  };
  runtime: {
    isLive(sessionId: string): boolean;
    liveSessionIds(): string[];
    pendingApprovals(sessionId: string): unknown[];
    backgroundTasks(sessionId: string): Array<{ ambient?: boolean }> | null;
    contextUsage(sessionId: string): Promise<LiveContextUsage | null>;
  };
  /** Status, supervision, permission mode and sandbox of the sessions the bridge starts or drives; survives restarts. */
  state: Pick<ForemanSessionStateService, 'get'>;
  /** The event log of the sessions Foreman supervises. */
  events: {
    since(sessionId: string, afterSequence: number, limit: number): ForemanBridgeEvent[];
    last(sessionId: string): ForemanBridgeEvent | null;
  };
  /** Which Foreman task a session belongs to. */
  taskIds: { get(sessionId: string): string | null };
  /** Root of Claude's transcripts; defaults to `~/.claude/projects`. */
  claudeProjectsRoot?: string;
  liveContextTimeoutMs?: number;
};

const DEFAULT_LIVE_CONTEXT_TIMEOUT_MS = 10_000;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 30;
const TOP_CONTEXT_CATEGORIES = 6;
// Context windows by model family; `[1m]` models have the extended window.
const STANDARD_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** Picks the window a transcript-based estimate is measured against. */
// Consumed by the reads service below and its tests.
export function resolveContextWindow(model: string | null, usedTokens: number): number {
  if (model?.includes('[1m]') || usedTokens > STANDARD_CONTEXT_WINDOW) {
    return EXTENDED_CONTEXT_WINDOW;
  }
  return STANDARD_CONTEXT_WINDOW;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type PendingApproval = { requestId: string; toolName: string; input: unknown; askedAt: string | null };

/**
 * The bridge's read side: what a session is (listing, status, digest, context, events) without changing anything. It also owns the two lookups
 * the services that do change sessions share with it, so no rule lives twice: whether a session exists and is a Claude session, and which
 * permission prompts it is waiting on.
 */
// Consumed by foreman.routes.ts (the read routes), and by foreman-sessions.service.ts and foreman-handover.service.ts through `requireClaudeSession`,
// `pendingApprovals` and `getState`.
export function createForemanSessionReadsService(deps: ForemanSessionReadsDependencies) {
  /** The session row, or the 404 (unknown) / 400 (not a Claude session) every call about a session starts with. */
  function requireClaudeSession(sessionId: string): SessionRow {
    const session = deps.sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    if (session.provider !== 'claude') {
      throw new AppError('The Foreman bridge only drives Claude sessions.', { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
    }
    return session;
  }

  /** The session's unanswered permission prompts, read defensively from the runtime's loosely typed records. */
  function pendingApprovals(sessionId: string): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const entry of deps.runtime.pendingApprovals(sessionId)) {
      const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
      if (!record || typeof record.requestId !== 'string') {
        continue;
      }
      const received = record.receivedAt;
      pending.push({
        requestId: record.requestId,
        toolName: typeof record.toolName === 'string' ? record.toolName : 'UnknownTool',
        input: record.input,
        askedAt: received instanceof Date ? received.toISOString() : typeof received === 'string' ? received : null,
      });
    }
    return pending;
  }

  /**
   * What is true right now wins (a prompt waiting, a run processing); with nothing live, the state service's remembered status decides,
   * so an error that ended a session before a restart is still reported afterwards. Only sessions the bridge tracks (started or handed over)
   * can be `error`: the state service is the one place that records a failed run.
   */
  function statusOf(sessionId: string): ForemanSessionStatus {
    if (pendingApprovals(sessionId).length > 0) {
      return 'waiting_permission';
    }
    if (deps.runs.isProcessing(sessionId)) {
      return 'running';
    }
    return deps.state.get(sessionId)?.status === 'error' ? 'error' : 'idle';
  }

  function summarize(session: SessionRow): ForemanSessionSummary {
    const { model, billing } = splitModelBilling(session.model);
    const tasks = deps.runtime.backgroundTasks(session.session_id) ?? [];
    const state = deps.state.get(session.session_id);
    return {
      id: session.session_id,
      taskId: deps.taskIds.get(session.session_id) ?? state?.taskId ?? null,
      projectPath: session.project_path,
      title: session.custom_name,
      model,
      billing,
      status: statusOf(session.session_id),
      permissionMode: state?.permissionMode ?? null,
      sandboxed: state?.sandboxJson != null,
      supervision: state?.supervision ?? null,
      live: deps.runs.isProcessing(session.session_id) || deps.runtime.isLive(session.session_id),
      lastActivity: session.updated_at ?? session.created_at ?? null,
      backgroundTasks: tasks.filter((task) => !task.ambient).length,
    };
  }

  /** What Foreman's `sessionState` call reports: where the session stands and how many events cloudcli has emitted for it. */
  function getState(sessionId: string): { sessionId: string; status: ForemanBridgeSessionStatus; lastSequence: number; supervision: ForemanSupervision | null } {
    requireClaudeSession(sessionId);
    const status = statusOf(sessionId);
    const running = status === 'running' || status === 'waiting_permission';
    const last = deps.events.last(sessionId);
    return {
      sessionId,
      status: running ? 'running' : last?.kind === 'session_end' ? 'ended' : 'idle',
      lastSequence: last?.sequence ?? 0,
      supervision: deps.state.get(sessionId)?.supervision ?? null,
    };
  }

  return {
    requireClaudeSession,
    pendingApprovals,
    getState,

    /** Live and recent Claude sessions, live ones first. */
    listSessions(options: { limit?: number; projectPath?: string } = {}): ForemanSessionSummary[] {
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT));
      const wantedPath = options.projectPath ? normalizeProjectPath(options.projectPath) : null;

      const rows = new Map<string, SessionRow>();
      for (const row of deps.sessionsDb.getRecentSessionsPage(limit, 0).sessions) {
        if (row.provider === 'claude') {
          rows.set(row.session_id, row);
        }
      }
      // A live session older than the page (e.g. a long-running background run) still belongs in the list.
      for (const sessionId of new Set([...deps.runs.listRunningSessionIds(), ...deps.runtime.liveSessionIds()])) {
        const row = rows.has(sessionId) ? null : deps.sessionsDb.getSessionById(sessionId);
        if (row && row.provider === 'claude' && !row.isArchived) {
          rows.set(row.session_id, row);
        }
      }

      return [...rows.values()]
        .filter((row) => !wantedPath || (row.project_path !== null && normalizeProjectPath(row.project_path) === wantedPath))
        .map(summarize)
        .sort((a, b) => Number(b.live) - Number(a.live) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    },

    /** The session's events above `afterSequence`, oldest first, at most `limit` of them (the reconciliation call). */
    eventsSince(sessionId: string, afterSequence: number, limit: number) {
      requireClaudeSession(sessionId);
      const events = deps.events.since(sessionId, afterSequence, limit + 1);
      return { sessionId, events: events.slice(0, limit), hasMore: events.length > limit };
    },

    /** Condensed view of the last `turns` turns of a session, read from its transcript. */
    async getDigest(sessionId: string, turns: number): Promise<{ session: ForemanSessionSummary; digest: SessionDigestBody }> {
      const session = requireClaudeSession(sessionId);
      const file = await locateTranscript(session, deps.claudeProjectsRoot);
      const transcript = file ? await readTranscriptRows(file, (rows) => hasTurnStarts(rows, turns)) : null;
      if (!transcript) {
        throw new AppError('No transcript exists for this session yet.', { code: 'TRANSCRIPT_NOT_FOUND', statusCode: 404 });
      }
      return {
        session: summarize(session),
        digest: buildSessionDigest(transcript.rows, { turns, truncatedHead: transcript.truncatedHead }),
      };
    },

    /** Context-window usage: measured by the live process when there is one, else estimated from the transcript. */
    async getContext(sessionId: string): Promise<ForemanContextReport> {
      const session = requireClaudeSession(sessionId);
      const { model } = splitModelBilling(session.model);
      let note: string | null = null;

      if (deps.runtime.isLive(sessionId)) {
        try {
          const usage = await withTimeout(
            deps.runtime.contextUsage(sessionId),
            deps.liveContextTimeoutMs ?? DEFAULT_LIVE_CONTEXT_TIMEOUT_MS,
            'context usage',
          );
          if (usage && usage.maxTokens > 0) {
            return {
              sessionId,
              source: 'live',
              model: usage.model || model,
              usedTokens: usage.totalTokens,
              windowTokens: usage.maxTokens,
              rawWindowTokens: usage.rawMaxTokens,
              fraction: usage.totalTokens / usage.maxTokens,
              autoCompactThreshold: usage.autoCompactThreshold ?? null,
              isAutoCompactEnabled: usage.isAutoCompactEnabled,
              categories: usage.categories
                .filter((category) => category.kind === 'used' && category.tokens > 0)
                .sort((a, b) => b.tokens - a.tokens)
                .slice(0, TOP_CONTEXT_CATEGORIES)
                .map(({ name, tokens }) => ({ name, tokens })),
              measuredAt: new Date().toISOString(),
              note: null,
            };
          }
        } catch (error) {
          note = `Live measurement failed (${error instanceof Error ? error.message : String(error)}); estimated from the transcript.`;
        }
      }

      const file = await locateTranscript(session, deps.claudeProjectsRoot);
      const transcript = file ? await readTranscriptRows(file, (rows) => estimateContextFromTranscript(rows) !== null) : null;
      const estimate = transcript ? estimateContextFromTranscript(transcript.rows) : null;
      if (!estimate) {
        return {
          sessionId,
          source: 'unknown',
          model,
          usedTokens: null,
          windowTokens: null,
          rawWindowTokens: null,
          fraction: null,
          autoCompactThreshold: null,
          isAutoCompactEnabled: null,
          categories: [],
          measuredAt: null,
          note: note ?? 'No usage has been recorded for this session yet.',
        };
      }

      const windowTokens = resolveContextWindow(model, estimate.usedTokens);
      return {
        sessionId,
        source: 'transcript',
        model,
        usedTokens: estimate.usedTokens,
        windowTokens,
        rawWindowTokens: null,
        fraction: estimate.usedTokens / windowTokens,
        autoCompactThreshold: null,
        isAutoCompactEnabled: null,
        categories: [],
        measuredAt: estimate.at,
        note: note ?? (estimate.basis === 'compact_boundary'
          ? 'Size right after the last compaction; no request has been made since.'
          : 'Estimated from the last assistant message.'),
      };
    },
  };
}

export type ForemanSessionReadsService = ReturnType<typeof createForemanSessionReadsService>;

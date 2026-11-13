import type { ForemanSessionStateRow } from '@/modules/database/index.js';
import { parseGuardConfig, type ForemanGuardConfig } from '@/modules/foreman/foreman-guard.service.js';
import type { ClaudeRuntimeEvent, ForemanBilling } from '@/shared/types.js';

export type ForemanSessionStatus = ForemanSessionStateRow['status'];

/** What the bridge remembers about a session it started or drives; survives a cloudcli restart. */
export type ForemanSessionState = {
  sessionId: string;
  taskId: string | null;
  status: ForemanSessionStatus;
  /** The permission mode Foreman last chose for the session; a resumed run keeps it. */
  permissionMode: string | null;
  billing: ForemanBilling | null;
  /** The risky-action guard the session runs under; null for a session without one. */
  guard: ForemanGuardConfig | null;
  updatedAt: string;
};

/** The storage the service needs; `foremanSessionStateDb` in production, anything with these four calls in tests. */
export type ForemanSessionStateStore = {
  get(sessionId: string): ForemanSessionStateRow | null;
  upsert(row: ForemanSessionStateRow): void;
  updateStatus(sessionId: string, status: ForemanSessionStatus, updatedAt: string): boolean;
  settleAfterRestart(updatedAt: string): { reset: number; waitingPermission: number };
};

/** Fields `track` may set. `undefined` leaves a field as it is; `null` clears it. */
export type ForemanSessionStatePatch = {
  taskId?: string | null;
  status?: ForemanSessionStatus;
  permissionMode?: string | null;
  billing?: ForemanBilling | null;
  guard?: ForemanGuardConfig | null;
};

/**
 * Stand-in for a stored guard that can no longer be read. A guard that cannot be read must not wave calls through, so
 * this one asks about every shell command and every call that names a path (the two things the classifier looks at).
 */
const ASK_ABOUT_EVERYTHING_GUARD: ForemanGuardConfig = {
  enabled: true,
  riskyPatterns: ['[\\s\\S]'],
  secretPatterns: ['[\\s\\S]'],
  writeOutsideRepo: true,
};

type DeriveStatus = (event: ClaudeRuntimeEvent, current: ForemanSessionStatus, pending: Set<string>) => ForemanSessionStatus | null;

function isErrorResult(message: Record<string, unknown>): boolean {
  return message.is_error === true || String(message.subtype ?? '').startsWith('error');
}

/**
 * The status a runtime event leaves a session in, or null when it does not change it.
 * `pending` holds the ids of the session's unanswered permission prompts and is updated here.
 */
const deriveStatus: DeriveStatus = (event, current, pending) => {
  switch (event.kind) {
    case 'run_started':
      pending.clear();
      return 'running';
    case 'permission_request':
      pending.add(event.requestId);
      return 'waiting_permission';
    case 'permission_resolved':
      // Whoever answers (the chat UI, the bridge, a timeout or an abort), the session leaves
      // `waiting_permission` only when its last prompt is gone, and never once the run has already ended.
      pending.delete(event.requestId);
      return current === 'waiting_permission' && pending.size === 0 ? 'running' : null;
    case 'turn_result':
      return isErrorResult(event.message) ? 'error' : 'idle';
    case 'run_error':
      return 'error';
    case 'run_ended':
      pending.clear();
      if (event.reason === 'error') {
        return 'error';
      }
      return current === 'running' || current === 'waiting_permission' ? 'idle' : null;
    default:
      return null;
  }
};

/**
 * Remembers, across cloudcli restarts, what the Foreman bridge needs to keep driving a session: its status, the
 * permission mode and guard it was started with, its billing mode and task.
 *
 * Only sessions the bridge has `track`ed are recorded; runtime events of any other session are ignored. Every write
 * goes through an in-memory copy first, so a failing database never breaks a run (it is logged and the bridge carries
 * on with what it has until the next restart).
 */
// Consumed by foreman.module.ts (runtime events, boot recovery) and foreman-sessions.service.ts (start, resume, listing).
export function createForemanSessionStateService(dependencies: {
  store: ForemanSessionStateStore;
  now?: () => Date;
  /** Diagnostic sink for notable events (boot recovery) and persistence failures. */
  log?: (message: string) => void;
}) {
  const { store } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? (() => undefined);
  // A session with no stored state is remembered as null: every runtime event of every session passes through here.
  const cache = new Map<string, ForemanSessionState | null>();
  const pendingPrompts = new Map<string, Set<string>>();

  function fromRow(row: ForemanSessionStateRow): ForemanSessionState {
    let guard: ForemanGuardConfig | null = null;
    if (row.guard_json) {
      try {
        guard = parseGuardConfig(JSON.parse(row.guard_json)) ?? null;
      } catch {
        log(`stored guard of session ${row.session_id} is unreadable; it will ask about every shell command and path`);
        guard = ASK_ABOUT_EVERYTHING_GUARD;
      }
    }
    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      status: row.status,
      permissionMode: row.permission_mode,
      billing: row.billing === 'api-key' || row.billing === 'subscription' ? row.billing : null,
      guard,
      updatedAt: row.updated_at,
    };
  }

  function toRow(state: ForemanSessionState): ForemanSessionStateRow {
    return {
      session_id: state.sessionId,
      task_id: state.taskId,
      status: state.status,
      permission_mode: state.permissionMode,
      billing: state.billing,
      guard_json: state.guard ? JSON.stringify(state.guard) : null,
      updated_at: state.updatedAt,
    };
  }

  function persist(action: () => void): void {
    try {
      action();
    } catch (error) {
      log(`session state not persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let recovery: { reset: number; waitingPermission: number } | null = null;

  /**
   * Settles what the previous process left behind. The process every run lived in is gone: sessions recorded as
   * `running` become `idle`, and the prompts of those recorded as `waiting_permission` can no longer be answered, so
   * they become `idle` too (errors stay). Runs at most once per service instance and returns what changed.
   *
   * The module is built before the database is initialised, so this cannot run at construction; every other call
   * makes sure it has run first, which puts it ahead of the first request or runtime event after boot.
   */
  function recoverAfterRestart(): { reset: number; waitingPermission: number } {
    if (recovery) {
      return recovery;
    }
    recovery = { reset: 0, waitingPermission: 0 };
    cache.clear();
    pendingPrompts.clear();
    try {
      recovery = store.settleAfterRestart(now().toISOString());
      if (recovery.reset > 0) {
        log(
          `restart: ${recovery.reset} Foreman session(s) recorded as running or waiting are now idle (their process is gone)`
          + (recovery.waitingPermission > 0
            ? `; ${recovery.waitingPermission} of them were waiting on a permission prompt that can no longer be answered, so it was dropped`
            : ''),
        );
      }
    } catch (error) {
      log(`restart recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return recovery;
  }

  function get(sessionId: string): ForemanSessionState | null {
    recoverAfterRestart();
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null;
    }
    try {
      const row = store.get(sessionId);
      if (!row) {
        cache.set(sessionId, null);
        return null;
      }
      const state = fromRow(row);
      cache.set(sessionId, state);
      return state;
    } catch (error) {
      log(`session state not read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function setStatus(sessionId: string, status: ForemanSessionStatus): void {
    const current = get(sessionId);
    if (!current || current.status === status) {
      return;
    }
    const updatedAt = now().toISOString();
    cache.set(sessionId, { ...current, status, updatedAt });
    persist(() => void store.updateStatus(sessionId, status, updatedAt));
  }

  return {
    /** The remembered state of a session, or null when the bridge never started or drove it. */
    get,

    /** Records (or updates) the state of a session the bridge starts or drives; a new session starts `idle`. */
    track(sessionId: string, patch: ForemanSessionStatePatch): ForemanSessionState {
      const current = get(sessionId);
      const next: ForemanSessionState = {
        sessionId,
        taskId: patch.taskId === undefined ? current?.taskId ?? null : patch.taskId,
        status: patch.status ?? current?.status ?? 'idle',
        permissionMode: patch.permissionMode === undefined ? current?.permissionMode ?? null : patch.permissionMode,
        billing: patch.billing === undefined ? current?.billing ?? null : patch.billing,
        guard: patch.guard === undefined ? current?.guard ?? null : patch.guard,
        updatedAt: now().toISOString(),
      };
      cache.set(sessionId, next);
      persist(() => store.upsert(toRow(next)));
      return next;
    },

    /** Changes the status of a tracked session; a session the bridge does not track is left alone. */
    setStatus,

    recoverAfterRestart,

    /** Feeds one runtime event; moves a tracked session's status. Never throws (it runs inside the runtime loop). */
    observe(event: ClaudeRuntimeEvent): void {
      try {
        if (!event.sessionId) {
          return;
        }
        const current = get(event.sessionId);
        if (!current) {
          return;
        }
        let pending = pendingPrompts.get(event.sessionId);
        if (!pending) {
          pending = new Set<string>();
          pendingPrompts.set(event.sessionId, pending);
        }
        const next = deriveStatus(event, current.status, pending);
        if (next) {
          setStatus(event.sessionId, next);
        }
      } catch (error) {
        log(`runtime event not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export type ForemanSessionStateService = ReturnType<typeof createForemanSessionStateService>;

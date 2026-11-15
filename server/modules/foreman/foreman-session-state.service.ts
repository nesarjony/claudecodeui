import type { ForemanSessionStateRow } from '@/modules/database/index.js';
import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import { readToolLists } from '@/modules/foreman/foreman-owner-settings.service.js';
import { createSessionSandboxReader, isSandboxedSession } from '@/modules/foreman/foreman-session-sandbox.service.js';
import { deriveSessionStatus } from '@/modules/foreman/foreman-session-status.service.js';
import type { ClaudeRuntimeEvent, ForemanBilling, ForemanSandboxScope } from '@/shared/types.js';
import { isSandboxedPermissionMode } from '@/shared/utils.js';

export type ForemanSessionStatus = ForemanSessionStateRow['status'];

/** Who the session belongs to as far as Foreman is concerned: one it started, one the owner handed over, or one it no longer supervises. */
export type ForemanSupervision = ForemanSessionStateRow['supervision'];

/** The owner's tool lists when the session was handed over, and when that was (ISO): with its permission mode, the base Foreman's turns never exceed. */
type ForemanOwnerTools = { allowedTools: string[]; disallowedTools: string[]; adoptedAt: string };

/** What the bridge remembers about a session it started or drives; survives a cloudcli restart. */
export type ForemanSessionState = {
  sessionId: string;
  taskId: string | null;
  status: ForemanSessionStatus;
  /**
   * The mode the bridge's turns run in: the one Foreman last chose for a session it started (never one a sandboxed session may not run in),
   * the owner's for a session handed over (taken at adoption). A resumed run keeps it.
   */
  permissionMode: string | null;
  billing: ForemanBilling | null;
  /** The sandbox policy Foreman sent, as stored; null for a session without one (a person's own). Read through `sandboxOf`. */
  sandboxJson: string | null;
  /** Where the session works (`ForemanSandboxScope`), as stored with the policy it was checked against; null without a sandbox. */
  sandboxScopeJson: string | null;
  supervision: ForemanSupervision;
  /** For a session handed over: the owner's tool lists at adoption; null for any other, and for one adopted before they were stored. */
  ownerTools: ForemanOwnerTools | null;
  /** The project's HEAD when supervision began; null when it has no commit or is no repository. */
  baseHead: string | null;
  /** The session's last event sequence when supervision began (0 for a session Foreman started). */
  baseSequence: number;
  updatedAt: string;
};

/** The storage the service needs; `foremanSessionStateDb` in production, anything with these calls in tests. */
export type ForemanSessionStateStore = {
  get(sessionId: string): ForemanSessionStateRow | null;
  upsert(row: ForemanSessionStateRow): void;
  updateStatus(sessionId: string, status: ForemanSessionStatus, updatedAt: string): boolean;
  settleAfterRestart(updatedAt: string): { reset: number; waitingPermission: number };
  listSupervised(): Array<{ session_id: string; supervision: 'started' | 'adopted'; task_id: string | null }>;
};

/**
 * Fields `track` and `trackStrict` may set. `undefined` leaves a field as it is; `null` clears it. Only `trackStrict` records a sandbox (the
 * policy with the scope it was checked against), and nothing clears one: a session that has a sandbox keeps it.
 */
// Consumed by foreman-session-sandbox.service.ts, which records a starting session's sandbox with it.
export type ForemanSessionStatePatch = {
  taskId?: string | null;
  status?: ForemanSessionStatus;
  permissionMode?: string | null;
  billing?: ForemanBilling | null;
  sandbox?: { policy: ForemanSandboxPolicy; scope: ForemanSandboxScope };
  ownerTools?: ForemanOwnerTools | null;
  supervision?: ForemanSupervision;
  baseHead?: string | null;
  baseSequence?: number;
};

/** The owner's tool lists as stored; a value that is not a whole one reads as none, so the session's turns are refused rather than run wider. */
function readOwnerTools(json: string | null): ForemanOwnerTools | null {
  try {
    const value = JSON.parse(json ?? 'null') as { adoptedAt?: unknown } | null;
    const lists = readToolLists(value);
    return lists && typeof value?.adoptedAt === 'string' ? { ...lists, adoptedAt: value.adoptedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Remembers, across cloudcli restarts, what the Foreman bridge needs to keep driving a session: its status, the
 * permission mode and sandbox it was started with, its billing mode, task and starting commit.
 *
 * This is also the bridge's only record of whether a session's last run failed (status `error`, set by a failed turn or a failed run and cleared by
 * the next run or a clean turn). So only sessions Foreman started or was handed over can report `error`.
 *
 * Only sessions the bridge has `track`ed are recorded; runtime events of any other session are ignored. Every write
 * goes through an in-memory copy first, so a failing database never breaks a run (it is logged and the bridge carries
 * on with what it has until the next restart).
 */
// Consumed by foreman.module.ts (runtime events, boot recovery), foreman-sessions.service.ts (start, resume, the permission mode),
// foreman-session-reads.service.ts (listings and the `error` status, which this service alone tracks) and foreman-handover.service.ts (adopt, release).
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
  const sandboxes = createSessionSandboxReader({ store, log });

  function fromRow(row: ForemanSessionStateRow): ForemanSessionState {
    // A mode stored before sandboxed sessions were held to their prompts (`bypassPermissions`, `auto`) is not handed back to resume with.
    const sandboxed = isSandboxedSession({ supervision: row.supervision, sandboxJson: row.sandbox_json });
    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      status: row.status,
      permissionMode: sandboxed && row.permission_mode !== null && !isSandboxedPermissionMode(row.permission_mode) ? null : row.permission_mode,
      billing: row.billing === 'api-key' || row.billing === 'subscription' || row.billing === 'cap' ? row.billing : null,
      sandboxJson: row.sandbox_json,
      sandboxScopeJson: row.sandbox_scope_json,
      ownerTools: readOwnerTools(row.owner_tools_json),
      supervision: row.supervision,
      baseHead: row.base_head,
      baseSequence: row.base_sequence,
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
      sandbox_json: state.sandboxJson,
      sandbox_scope_json: state.sandboxScopeJson,
      owner_tools_json: state.ownerTools ? JSON.stringify(state.ownerTools) : null,
      supervision: state.supervision,
      base_head: state.baseHead,
      base_sequence: state.baseSequence,
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

  /** The state a patch leaves a session in (a new session starts `idle`). */
  function patched(sessionId: string, patch: ForemanSessionStatePatch): ForemanSessionState {
    const current = get(sessionId);
    return {
      sessionId,
      taskId: patch.taskId === undefined ? current?.taskId ?? null : patch.taskId,
      status: patch.status ?? current?.status ?? 'idle',
      permissionMode: patch.permissionMode === undefined ? current?.permissionMode ?? null : patch.permissionMode,
      billing: patch.billing === undefined ? current?.billing ?? null : patch.billing,
      sandboxJson: patch.sandbox === undefined ? current?.sandboxJson ?? null : JSON.stringify(patch.sandbox.policy),
      sandboxScopeJson: patch.sandbox === undefined ? current?.sandboxScopeJson ?? null : JSON.stringify(patch.sandbox.scope),
      ownerTools: patch.ownerTools === undefined ? current?.ownerTools ?? null : patch.ownerTools,
      supervision: patch.supervision ?? current?.supervision ?? 'started',
      baseHead: patch.baseHead === undefined ? current?.baseHead ?? null : patch.baseHead,
      baseSequence: patch.baseSequence ?? current?.baseSequence ?? 0,
      updatedAt: now().toISOString(),
    };
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

    /** Records (or updates) the state of a session the bridge starts or drives; a write that fails is logged, and memory carries on. */
    track(sessionId: string, patch: Omit<ForemanSessionStatePatch, 'sandbox'>): ForemanSessionState {
      const next = patched(sessionId, patch);
      cache.set(sessionId, next);
      persist(() => store.upsert(toRow(next)));
      return next;
    },

    /**
     * Like `track`, but the write must succeed: it throws when the database refuses it, and memory changes only after it succeeded. The
     * one way to record a sandbox, because a policy that is not stored is a later run without its sandbox.
     */
    trackStrict(sessionId: string, patch: ForemanSessionStatePatch): ForemanSessionState {
      const next = patched(sessionId, patch);
      store.upsert(toRow(next));
      cache.set(sessionId, next);
      if (patch.sandbox) {
        sandboxes.remember(sessionId, patch.sandbox);
      }
      return next;
    },

    /** Changes the status of a tracked session; a session the bridge does not track is left alone. */
    setStatus,

    recoverAfterRestart,

    /** The sessions Foreman supervises right now (started by it or handed over, not released), newest first. */
    listSupervised: () => store.listSupervised().map((row) => ({ sessionId: row.session_id, supervision: row.supervision, taskId: row.task_id })),

    /**
     * The sandbox a run of the session must apply (its policy and the scope stored with it), `null` for a session that has none, or why the
     * run must not start; `required` for a run the bridge marked as its own. Fails closed only for Foreman's runs (see foreman-session-sandbox.service.ts).
     */
    sandboxOf: sandboxes.sandboxOf,

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
        const next = deriveSessionStatus(event, current.status, pending);
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

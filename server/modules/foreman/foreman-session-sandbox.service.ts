import { isDeepStrictEqual } from 'node:util';

import type { ForemanSessionStateRow } from '@/modules/database/index.js';
import { parseSandboxPolicy, type ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import type { ForemanSessionStatePatch, ForemanSessionStateService, ForemanSupervision } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanSandboxScope } from '@/shared/types.js';
import { AppError, isSandboxedPermissionMode, SANDBOXED_PERMISSION_MODES } from '@/shared/utils.js';

/**
 * The sandbox of a session the Foreman bridge drives: whether the session is sandboxed, the permission modes it may run in, how its policy is
 * recorded when it starts and how each of its runs reads it back.
 */

/** Every session Foreman started runs sandboxed (a stored policy says so too); one handed over runs as its owner set it up. */
// Consumed by foreman-sessions.service.ts (the modes a message may ask for, the mark on a run) and foreman-session-state.service.ts (the
// stored mode it hands back).
export function isSandboxedSession(session: { supervision: ForemanSupervision; sandboxJson: string | null }): boolean {
  return session.supervision === 'started' || session.sandboxJson !== null;
}

/**
 * Refuses a permission mode a sandboxed session may not run in. The sandbox isolates Bash only; the file tools are held by the prompts that
 * `bypassPermissions` skips and `auto` hands to a classifier.
 */
// Consumed by foreman-session-start.service.ts for a start and by foreman-sessions.service.ts for every message or compact of a sandboxed session.
export function requireSandboxedMode(permissionMode: string | undefined): void {
  if (permissionMode !== undefined && !isSandboxedPermissionMode(permissionMode)) {
    throw new AppError(
      `permissionMode "${permissionMode}" is not allowed for a sandboxed session: the sandbox covers Bash only and the file tools rely on the prompts it would skip. Use one of: ${SANDBOXED_PERMISSION_MODES.join(', ')}.`,
      { code: 'PERMISSION_MODE_FORBIDDEN', statusCode: 400 },
    );
  }
}

/**
 * Records a session the bridge starts, with its sandbox and the scope it was checked against, before its first run: with a write that throws
 * when it fails, then read back the way every run of the session reads it. Anything but exactly the policy that was sent stops the start,
 * because the session's runs would not find their sandbox.
 */
// Consumed by foreman-session-start.service.ts when it starts a session.
export function recordSandboxedStart(
  state: Pick<ForemanSessionStateService, 'trackStrict' | 'sandboxOf'>,
  sessionId: string,
  patch: ForemanSessionStatePatch & { sandbox: NonNullable<ForemanSessionStatePatch['sandbox']> },
): void {
  const notRecorded = (reason: string) =>
    new AppError(`The sandbox of the session was not recorded (${reason}), so nothing was run.`, { code: 'SANDBOX_NOT_RECORDED', statusCode: 500 });
  try {
    state.trackStrict(sessionId, patch);
  } catch (error) {
    throw notRecorded(`the write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const readBack = state.sandboxOf(sessionId, { required: true });
  if (!readBack || !('policy' in readBack) || !isDeepStrictEqual(readBack.policy, patch.sandbox.policy)) {
    throw notRecorded('what is stored does not read back as the policy that was sent');
  }
}

/** The scope stored with a policy. A policy stored without one (before scopes were recorded) cannot be checked, so it is refused like a malformed one. */
function readSandboxScope(json: string | null): ForemanSandboxScope {
  const scope = JSON.parse(json ?? 'null') as { projectPath?: unknown; gitCommonDir?: unknown } | null;
  const gitCommonDir = scope?.gitCommonDir;
  if (typeof scope?.projectPath !== 'string' || (gitCommonDir !== null && typeof gitCommonDir !== 'string')) {
    throw new Error('no scope is stored with the sandbox');
  }
  return { projectPath: scope.projectPath, gitCommonDir };
}

/** What a run of a session is to do about its sandbox: apply this policy, not run at all (and why), or run without one (`null`). */
type SandboxAnswer = { policy: ForemanSandboxPolicy } | { refuse: string } | null;

/**
 * Reads the sandbox each run of a session must apply, failing closed only for the runs that are Foreman's.
 *
 * The database is read afresh for every run. Whether a run is Foreman's is known without that read: the bridge marks every run it dispatches
 * for a sandboxed session (`required`). So:
 * - a stored policy applies to every run of the session, marked or not;
 * - no stored policy: a marked run is refused (it is Foreman's and its sandbox is gone), any other runs as before (the owner's session);
 * - the read fails: the policy last read or written in this process applies; without one a marked run is refused and any other runs as
 *   before, so an unreadable table never stops the owner's own sessions. Left open: a person typing into a worker's session in the UI while
 *   the table cannot be read and nothing is remembered runs that turn without the sandbox.
 * - a stored policy that is malformed, has no stored scope, or that today's checks refuse (against the scope stored with it) refuses every run.
 */
// Consumed by foreman-session-state.service.ts, which records policies through `remember` and answers the runtime's sandbox provider with `sandboxOf`.
export function createSessionSandboxReader(dependencies: {
  store: { get(sessionId: string): ForemanSessionStateRow | null };
  log: (message: string) => void;
}) {
  const known = new Map<string, ForemanSandboxPolicy>();

  return {
    /** Remembers a policy that was just written, as the one to apply while the database cannot be read. */
    remember(sessionId: string, policy: ForemanSandboxPolicy): void {
      known.set(sessionId, policy);
    },

    sandboxOf(sessionId: string, run: { required: boolean } = { required: false }): SandboxAnswer {
      let row: ForemanSessionStateRow | null;
      try {
        row = dependencies.store.get(sessionId);
      } catch (error) {
        const remembered = known.get(sessionId);
        if (remembered) {
          return { policy: remembered };
        }
        const reason = error instanceof Error ? error.message : String(error);
        dependencies.log(`sandbox of session ${sessionId} not read: ${reason}`);
        return run.required ? { refuse: `The sandbox of this session could not be read (${reason}), so it does not run.` } : null;
      }
      if (!row?.sandbox_json) {
        return run.required ? { refuse: 'This run was started for a sandboxed session, but no sandbox is stored for it, so it does not run.' } : null;
      }
      try {
        const policy = parseSandboxPolicy(JSON.parse(row.sandbox_json), readSandboxScope(row.sandbox_scope_json));
        known.set(sessionId, policy);
        return { policy };
      } catch {
        return { refuse: 'The stored sandbox of this session is malformed or no longer allowed, so it does not run: a sandboxed session never runs without isolation.' };
      }
    },
  };
}

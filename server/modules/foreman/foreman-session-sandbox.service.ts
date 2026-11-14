import type { ForemanSessionStateRow } from '@/modules/database/index.js';
import { parseSandboxPolicy, type ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';

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
 * - a stored policy that is malformed, or that today's checks refuse, refuses every run.
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
        const policy = parseSandboxPolicy(JSON.parse(row.sandbox_json));
        known.set(sessionId, policy);
        return { policy };
      } catch {
        return { refuse: 'The stored sandbox of this session is malformed or no longer allowed, so it does not run: a sandboxed session never runs without isolation.' };
      }
    },
  };
}

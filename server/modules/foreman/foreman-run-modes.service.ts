import type { foremanRunModesDb } from '@/modules/database/index.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

/**
 * Remembers the permission mode the last run of every Claude session started in (the effective mode the runtime reports on `run_started`),
 * owner sessions included and before any hand-over, so a session handed over to Foreman runs in its owner's mode and never in a default of
 * the bridge's. Survives restarts (`foreman_run_modes`).
 */
// Consumed by foreman.module.ts, which feeds it every runtime event and hands it to the hand-over, and by the route tests' world.
export function createForemanRunModes(deps: {
  store: Pick<typeof foremanRunModesDb, 'record' | 'get'>;
  now?: () => Date;
  /** Where a failed read or write is reported; neither ever throws. */
  log?: (message: string) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  return {
    /** Feeds one runtime event: a `run_started` is one upsert, anything else nothing. Never throws, as it runs inside the runtime loop. */
    observe(event: ClaudeRuntimeEvent): void {
      if (event.kind !== 'run_started' || !event.sessionId || !event.permissionMode) {
        return;
      }
      try {
        deps.store.record(event.sessionId, event.permissionMode, now().toISOString());
      } catch (error) {
        log(`run mode of ${event.sessionId} not recorded: ${reason(error)}`);
      }
    },

    /** The mode the session's last run started in; null when none is recorded or it cannot be read (a hand-over then waits instead of guessing). */
    modeOf(sessionId: string): string | null {
      try {
        return deps.store.get(sessionId)?.permission_mode ?? null;
      } catch (error) {
        log(`run mode of ${sessionId} not read: ${reason(error)}`);
        return null;
      }
    },
  };
}

// Consumed by foreman-handover.service.ts, which takes the owner's mode from it at adoption.
export type ForemanRunModes = ReturnType<typeof createForemanRunModes>;

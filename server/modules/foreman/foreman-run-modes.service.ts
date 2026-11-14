import type { foremanRunModesDb } from '@/modules/database/index.js';
import { readToolLists } from '@/modules/foreman/foreman-owner-settings.service.js';
import type { ClaudeRuntimeEvent, ForemanOwnerSettings } from '@/shared/types.js';

/**
 * Remembers what the owner's last run of every Claude session started with: the effective permission mode and the tool lists of its options
 * (as the runtime reports them on `run_started`), owner sessions included and before any hand-over, so a session handed over to Foreman runs
 * Foreman's turns with no more than its owner's settings and never with a default of the bridge's. A run the bridge dispatched is not
 * recorded: what Foreman runs with never counts as the owner's. Survives restarts (`foreman_run_modes`).
 */
// Consumed by foreman.module.ts, which feeds it every runtime event and hands it to the hand-over and the sessions service, and by the route tests' world.
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
    /** Feeds one runtime event: an owner's `run_started` is one upsert, anything else nothing. Never throws, as it runs inside the runtime loop. */
    observe(event: ClaudeRuntimeEvent): void {
      if (event.kind !== 'run_started' || !event.sessionId || !event.permissionMode || event.foremanDispatch) {
        return;
      }
      try {
        const tools = JSON.stringify({ allowedTools: event.allowedTools, disallowedTools: event.disallowedTools });
        deps.store.record(event.sessionId, event.permissionMode, tools, now().toISOString());
      } catch (error) {
        log(`run mode of ${event.sessionId} not recorded: ${reason(error)}`);
      }
    },

    /**
     * What the owner's last run of the session started with, and when it started. Null when nothing is recorded, its tools are not (a row
     * from before they were) or it cannot be read: a hand-over then waits for the owner's next run instead of guessing.
     */
    settingsOf(sessionId: string): { settings: ForemanOwnerSettings; seenAt: string } | null {
      try {
        const row = deps.store.get(sessionId);
        const tools = row?.tools_json ? readToolLists(JSON.parse(row.tools_json)) : null;
        return row && tools ? { settings: { permissionMode: row.permission_mode, ...tools }, seenAt: row.seen_at } : null;
      } catch (error) {
        log(`run mode of ${sessionId} not read: ${reason(error)}`);
        return null;
      }
    },
  };
}

// Consumed by foreman-handover.service.ts, which stores the owner's settings at adoption, and foreman-sessions.service.ts, which narrows them by the owner's latest run.
export type ForemanRunModes = ReturnType<typeof createForemanRunModes>;

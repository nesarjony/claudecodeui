/**
 * Foreman run modes repository.
 *
 * The permission mode and tool lists the owner's last run of each Claude session started with, for every session (the owner's own too).
 * Plain storage; the bridge's `foreman-run-modes.service.ts` writes it from the runtime's `run_started`, and the hand-over and the sessions
 * service read it.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanRunModeRow = {
  session_id: string;
  permission_mode: string;
  seen_at: string;
  /** `{ allowedTools, disallowedTools }` as JSON; null for a row recorded before the tools were. */
  tools_json: string | null;
};

export const foremanRunModesDb = {
  /** Records the mode and tool lists (JSON) a run of the session started with, replacing the ones before. */
  record(sessionId: string, permissionMode: string, toolsJson: string, seenAt: string): void {
    getConnection()
      .prepare(
        `INSERT INTO foreman_run_modes (session_id, permission_mode, seen_at, tools_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET permission_mode = excluded.permission_mode, seen_at = excluded.seen_at, tools_json = excluded.tools_json`,
      )
      .run(sessionId, permissionMode, seenAt, toolsJson);
  },

  get(sessionId: string): ForemanRunModeRow | null {
    const row = getConnection()
      .prepare('SELECT session_id, permission_mode, seen_at, tools_json FROM foreman_run_modes WHERE session_id = ?')
      .get(sessionId) as ForemanRunModeRow | undefined;
    return row ?? null;
  },
};

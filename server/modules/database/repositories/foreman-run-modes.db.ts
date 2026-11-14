/**
 * Foreman run modes repository.
 *
 * The permission mode the last run of each Claude session started in, for every session (the owner's own too). Plain storage; the bridge's
 * `foreman-run-modes.service.ts` writes it from the runtime's `run_started` and the hand-over reads it.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanRunModeRow = {
  session_id: string;
  permission_mode: string;
  seen_at: string;
};

export const foremanRunModesDb = {
  /** Records the mode a run of the session started in, replacing the one before. */
  record(sessionId: string, permissionMode: string, seenAt: string): void {
    getConnection()
      .prepare(
        `INSERT INTO foreman_run_modes (session_id, permission_mode, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET permission_mode = excluded.permission_mode, seen_at = excluded.seen_at`,
      )
      .run(sessionId, permissionMode, seenAt);
  },

  get(sessionId: string): ForemanRunModeRow | null {
    const row = getConnection()
      .prepare('SELECT session_id, permission_mode, seen_at FROM foreman_run_modes WHERE session_id = ?')
      .get(sessionId) as ForemanRunModeRow | undefined;
    return row ?? null;
  },
};

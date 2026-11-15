/**
 * Foreman hand-over grants repository.
 *
 * One row per session whose logged-in owner allowed Foreman to adopt it. Plain storage; who may grant, for how long and when a grant is used
 * up are the bridge's `foreman-handover.service.ts`. Times are ISO strings from `Date.toISOString`, so comparing them as text compares the times.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanHandoverGrantRow = {
  session_id: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
};

export const foremanHandoverGrantsDb = {
  /** Records a grant; a newer grant for the same session replaces the older one. */
  put(row: ForemanHandoverGrantRow): void {
    getConnection()
      .prepare(
        `INSERT INTO foreman_handover_grants (session_id, granted_by, created_at, expires_at)
         VALUES (@session_id, @granted_by, @created_at, @expires_at)
         ON CONFLICT(session_id) DO UPDATE SET
           granted_by = excluded.granted_by,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(row);
  },

  /**
   * Uses up the session's grant if it is still valid at `nowIso`. One DELETE: of two callers racing for the same grant only one gets true.
   * False when there is none, it expired, or it was used already.
   */
  consume(sessionId: string, nowIso: string): boolean {
    return getConnection()
      .prepare('DELETE FROM foreman_handover_grants WHERE session_id = ? AND expires_at > ?')
      .run(sessionId, nowIso).changes > 0;
  },

  /** Withdraws the session's grant, valid or expired; true when there was one. */
  revoke(sessionId: string): boolean {
    return getConnection().prepare('DELETE FROM foreman_handover_grants WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /** Drops every grant that has expired by `nowIso`; returns how many. */
  purgeExpired(nowIso: string): number {
    return getConnection().prepare('DELETE FROM foreman_handover_grants WHERE expires_at <= ?').run(nowIso).changes;
  },
};

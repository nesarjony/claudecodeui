/**
 * Foreman session state repository.
 *
 * One row per session the Foreman bridge started or drives: its last known status, the permission mode Foreman
 * chose, the billing mode, the Foreman task it belongs to, the sandbox policy it runs under (as JSON, with the scope it was checked against)
 * and the HEAD it started from.
 * Plain storage; the meaning of the columns lives in the bridge's `foreman-session-state.service.ts`.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanSessionStateRow = {
  session_id: string;
  task_id: string | null;
  status: 'running' | 'idle' | 'waiting_permission' | 'error';
  permission_mode: string | null;
  billing: string | null;
  sandbox_json: string | null;
  supervision: 'started' | 'adopted' | 'released';
  base_head: string | null;
  base_sequence: number;
  updated_at: string;
  sandbox_scope_json: string | null;
};

const COLUMNS = 'session_id, task_id, status, permission_mode, billing, sandbox_json, supervision, base_head, base_sequence, updated_at, sandbox_scope_json';

export const foremanSessionStateDb = {
  get(sessionId: string): ForemanSessionStateRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM foreman_session_state WHERE session_id = ?`)
      .get(sessionId) as ForemanSessionStateRow | undefined;
    return row ?? null;
  },

  /**
   * Inserts or replaces the whole row for a session, except that a recorded sandbox is never erased: a row written without one (by a
   * caller that could not read the row first) keeps the policy it had, and the scope recorded with it.
   */
  upsert(row: ForemanSessionStateRow): void {
    getConnection()
      .prepare(
        `INSERT INTO foreman_session_state (${COLUMNS})
         VALUES (@session_id, @task_id, @status, @permission_mode, @billing, @sandbox_json, @supervision, @base_head, @base_sequence, @updated_at, @sandbox_scope_json)
         ON CONFLICT(session_id) DO UPDATE SET
           task_id = excluded.task_id,
           status = excluded.status,
           permission_mode = excluded.permission_mode,
           billing = excluded.billing,
           sandbox_json = COALESCE(excluded.sandbox_json, foreman_session_state.sandbox_json),
           supervision = excluded.supervision,
           base_head = excluded.base_head,
           base_sequence = excluded.base_sequence,
           updated_at = excluded.updated_at,
           sandbox_scope_json = COALESCE(excluded.sandbox_scope_json, foreman_session_state.sandbox_scope_json)`,
      )
      .run(row);
  },

  /** The sessions Foreman supervises right now: started by it or handed over to it, not released. */
  listSupervised(): Array<{ session_id: string; supervision: 'started' | 'adopted'; task_id: string | null }> {
    return getConnection()
      .prepare("SELECT session_id, supervision, task_id FROM foreman_session_state WHERE supervision IN ('started', 'adopted') ORDER BY updated_at DESC")
      .all() as Array<{ session_id: string; supervision: 'started' | 'adopted'; task_id: string | null }>;
  },

  /** Changes only the status of an existing row; returns false when the session has no row. */
  updateStatus(sessionId: string, status: ForemanSessionStateRow['status'], updatedAt: string): boolean {
    const result = getConnection()
      .prepare('UPDATE foreman_session_state SET status = ?, updated_at = ? WHERE session_id = ?')
      .run(status, updatedAt, sessionId);
    return result.changes > 0;
  },

  /**
   * Settles the rows a restart leaves behind: nothing is running or waiting any more, so `running` and
   * `waiting_permission` become `idle` (an `error` stays an error). Reports how many rows changed and how many of
   * them were waiting on a permission prompt, which can no longer be answered.
   */
  settleAfterRestart(updatedAt: string): { reset: number; waitingPermission: number } {
    const db = getConnection();
    const settle = db.transaction(() => {
      const waiting = db
        .prepare("SELECT COUNT(*) AS count FROM foreman_session_state WHERE status = 'waiting_permission'")
        .get() as { count: number };
      const reset = db
        .prepare(
          `UPDATE foreman_session_state SET status = 'idle', updated_at = ?
           WHERE status IN ('running', 'waiting_permission')`,
        )
        .run(updatedAt).changes;
      return { reset, waitingPermission: waiting.count };
    });
    return settle();
  },
};

/**
 * Foreman event repository.
 *
 * The event log of the sessions the Foreman bridge drives: one row per event, numbered per session from 1 without gaps.
 * Plain storage; what an event means and when it is pushed lives in the bridge's `foreman-event-*.service.ts` files.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanEventRow = {
  session_id: string;
  sequence: number;
  id: string;
  kind: string;
  payload_json: string;
  created_at: string;
  acked_at: string | null;
};

const COLUMNS = 'session_id, sequence, id, kind, payload_json, created_at, acked_at';

export const foremanEventsDb = {
  /**
   * Stores an event under the session's next sequence number and returns the row. Numbering and insert share one
   * transaction, so two events of a session can never get the same number.
   */
  append(sessionId: string, kind: string, payloadJson: string, createdAt: string): ForemanEventRow {
    const db = getConnection();
    const append = db.transaction((): ForemanEventRow => {
      const last = db
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM foreman_events WHERE session_id = ?')
        .get(sessionId) as { last: number };
      const sequence = last.last + 1;
      const row: ForemanEventRow = {
        session_id: sessionId,
        sequence,
        id: `${sessionId}:${sequence}`,
        kind,
        payload_json: payloadJson,
        created_at: createdAt,
        acked_at: null,
      };
      db.prepare(
        `INSERT INTO foreman_events (${COLUMNS})
         VALUES (@session_id, @sequence, @id, @kind, @payload_json, @created_at, @acked_at)`,
      ).run(row);
      return row;
    });
    return append();
  },

  /** The session's events with a sequence above `afterSequence`, oldest first. */
  since(sessionId: string, afterSequence: number, limit: number): ForemanEventRow[] {
    return getConnection()
      .prepare(`SELECT ${COLUMNS} FROM foreman_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(sessionId, afterSequence, limit) as ForemanEventRow[];
  },

  /** The newest event of the session, or null when it has none. */
  last(sessionId: string): ForemanEventRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM foreman_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`)
      .get(sessionId) as ForemanEventRow | undefined;
    return row ?? null;
  },

  /** The oldest unacknowledged event of each session: the next one to push for it, because a session's events go in order. */
  oldestUnackedPerSession(): ForemanEventRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM foreman_events AS e
         WHERE acked_at IS NULL
           AND sequence = (SELECT MIN(sequence) FROM foreman_events WHERE session_id = e.session_id AND acked_at IS NULL)
         ORDER BY created_at, session_id`,
      )
      .all() as ForemanEventRow[];
  },

  /** How many commits the session's `turn_end` events above `afterSequence` have reported. */
  reportedCommits(sessionId: string, afterSequence: number): number {
    const row = getConnection()
      .prepare("SELECT COALESCE(SUM(json_extract(payload_json, '$.commitCount')), 0) AS total FROM foreman_events WHERE session_id = ? AND sequence > ? AND kind = 'turn_end'")
      .get(sessionId, afterSequence) as { total: number };
    return row.total;
  },

  markAcked(id: string, ackedAt: string): void {
    getConnection().prepare('UPDATE foreman_events SET acked_at = ? WHERE id = ?').run(ackedAt, id);
  },
};

/**
 * Foreman idempotency repository.
 *
 * One row per idempotency key of a call that changed a session. Plain storage; the rules for repeats live in the
 * bridge's `foreman-idempotency.service.ts`.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ForemanIdempotencyRow = {
  key: string;
  operation: string;
  fingerprint: string;
  state: 'pending' | 'done';
  status_code: number | null;
  response_json: string | null;
  created_at: string;
};

const COLUMNS = 'key, operation, fingerprint, state, status_code, response_json, created_at';

export const foremanIdempotencyDb = {
  get(key: string): ForemanIdempotencyRow | null {
    const row = getConnection().prepare(`SELECT ${COLUMNS} FROM foreman_idempotency WHERE key = ?`).get(key) as
      | ForemanIdempotencyRow
      | undefined;
    return row ?? null;
  },

  /** Records that a call began. The insert is the claim: it fails when the key already has a row. */
  begin(key: string, operation: string, fingerprint: string, createdAt: string): void {
    getConnection()
      .prepare(
        `INSERT INTO foreman_idempotency (${COLUMNS})
         VALUES (?, ?, ?, 'pending', NULL, NULL, ?)`,
      )
      .run(key, operation, fingerprint, createdAt);
  },

  /** Stores the answer of a call that took effect. */
  complete(key: string, statusCode: number, responseJson: string): void {
    getConnection()
      .prepare("UPDATE foreman_idempotency SET state = 'done', status_code = ?, response_json = ? WHERE key = ?")
      .run(statusCode, responseJson, key);
  },

  /** Forgets a call that failed before it took effect, so the key can be used again. */
  release(key: string): void {
    getConnection().prepare("DELETE FROM foreman_idempotency WHERE key = ? AND state = 'pending'").run(key);
  },
};

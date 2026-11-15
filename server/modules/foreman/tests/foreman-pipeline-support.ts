import type { ForemanEventRow } from '@/modules/database/index.js';
import { createForemanEventStore, type ForemanEventStorage } from '@/modules/foreman/foreman-event-store.service.js';

/** The event table in memory, with the numbering rules of the real repository. */
export function createMemoryEventStorage(): ForemanEventStorage & { rows: ForemanEventRow[] } {
  const rows: ForemanEventRow[] = [];
  const ofSession = (sessionId: string) => rows.filter((row) => row.session_id === sessionId);
  return {
    rows,
    append(sessionId, kind, payloadJson, createdAt) {
      const sequence = ofSession(sessionId).length + 1;
      const row = { session_id: sessionId, sequence, id: `${sessionId}:${sequence}`, kind, payload_json: payloadJson, created_at: createdAt, acked_at: null };
      rows.push(row);
      return row;
    },
    since: (sessionId, after, limit) => ofSession(sessionId).filter((row) => row.sequence > after).slice(0, limit),
    last: (sessionId) => ofSession(sessionId).at(-1) ?? null,
    oldestUnackedPerSession: () => [...new Set(rows.map((row) => row.session_id))].flatMap((sessionId) => ofSession(sessionId).find((row) => row.acked_at === null) ?? []),
    reportedCommits: (sessionId, after) => ofSession(sessionId).filter((row) => row.sequence > after && row.kind === 'turn_end').reduce((sum, row) => sum + (JSON.parse(row.payload_json) as { commitCount: number }).commitCount, 0),
    markAcked(id, at) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.acked_at = at;
    },
  };
}

/** An event store over the in-memory storage with a fixed clock; the storage comes back too, for a test that writes rows itself. */
export function makeStore() {
  const storage = createMemoryEventStorage();
  return { storage, store: createForemanEventStore({ storage, now: () => new Date('2026-11-14T10:00:00.000Z') }) };
}

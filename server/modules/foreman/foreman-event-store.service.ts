import type { ForemanEventRow } from '@/modules/database/index.js';
import type { ForemanBridgeEvent, ForemanBridgeEventBody } from '@/shared/types.js';

/** The storage the service needs; `foremanEventsDb` in production, anything with these calls in tests. */
export type ForemanEventStorage = {
  append(sessionId: string, kind: string, payloadJson: string, createdAt: string): ForemanEventRow;
  since(sessionId: string, afterSequence: number, limit: number): ForemanEventRow[];
  last(sessionId: string): ForemanEventRow | null;
  oldestUnackedPerSession(): ForemanEventRow[];
  reportedCommits(sessionId: string, afterSequence: number): number;
  markAcked(id: string, ackedAt: string): void;
};

// A row is only ever written from a `ForemanBridgeEventBody`, so its kind and payload are those of one.
function toEvent(row: ForemanEventRow): ForemanBridgeEvent {
  const payload = JSON.parse(row.payload_json);
  // A turn_end stored before it carried `headSha` reads as "no head known": the shape every reader of the contract now expects.
  if (row.kind === 'turn_end' && payload.headSha === undefined) {
    payload.headSha = null;
  }
  return { id: row.id, sessionId: row.session_id, sequence: row.sequence, kind: row.kind, payload } as ForemanBridgeEvent;
}

/**
 * The log of what Foreman-driven sessions did: every event gets an id and the session's next sequence number when it is stored,
 * and stays until the end of time, so Foreman can ask for what it missed. Which events still have to be pushed is tracked beside
 * the log (`oldestUnackedPerSession`, `markAcked`), not by deleting from it.
 */
// Consumed by foreman.module.ts, which gives it to the recorder (writes), the pusher (acknowledgements), and the reads and hand-over services (sequences and event pages).
export function createForemanEventStore(dependencies: { storage: ForemanEventStorage; now?: () => Date }) {
  const { storage } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  return {
    /** Stores an event as the session's next one and returns it with its id and sequence. */
    append(sessionId: string, body: ForemanBridgeEventBody): ForemanBridgeEvent {
      return toEvent(storage.append(sessionId, body.kind, JSON.stringify(body.payload), now().toISOString()));
    },

    /** The session's events above `afterSequence`, oldest first. */
    since: (sessionId: string, afterSequence: number, limit: number): ForemanBridgeEvent[] => storage.since(sessionId, afterSequence, limit).map(toEvent),

    /** The newest event of the session; null while it has none. */
    last(sessionId: string): ForemanBridgeEvent | null {
      const row = storage.last(sessionId);
      return row ? toEvent(row) : null;
    },

    /** How many commits the session's `turn_end` events above `afterSequence` have reported, so the next one reports only what is new. */
    reportedCommits: (sessionId: string, afterSequence: number): number => storage.reportedCommits(sessionId, afterSequence),

    /** For each session, the oldest event Foreman has not acknowledged: the next one to push for it. */
    oldestUnackedPerSession: (): ForemanBridgeEvent[] => storage.oldestUnackedPerSession().map(toEvent),

    markAcked(eventId: string): void {
      storage.markAcked(eventId, now().toISOString());
    },
  };
}

export type ForemanEventStore = ReturnType<typeof createForemanEventStore>;

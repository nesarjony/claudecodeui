import { createHash } from 'node:crypto';

import type { ForemanIdempotencyRow } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** The storage the service needs; `foremanIdempotencyDb` in production, anything with these calls in tests. */
export type ForemanIdempotencyStorage = {
  get(key: string): ForemanIdempotencyRow | null;
  begin(key: string, operation: string, fingerprint: string, createdAt: string): void;
  complete(key: string, statusCode: number, responseJson: string): void;
  release(key: string): void;
};

/** What a call answered: the HTTP status and the JSON body, which a repeat of the key gets back unchanged. */
export type IdempotentAnswer = { status: number; body: unknown };

/** Identifies what a call asks for, so the key of one call cannot be reused for another. */
// Consumed by foreman.routes.ts for every call that changes a session.
export function fingerprintOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Applies each idempotency key at most once.
 *
 * The key is claimed before the call runs and its answer is stored when the call has taken effect; a repeat gets that answer back and
 * nothing runs again. A call that fails releases its key (an error answer is not stored), so a corrected retry runs. A repeat that comes
 * while the first call is still running waits for it. A repeat of a call that began in a process that has since died cannot be told
 * apart from one that never took effect, so it is refused with `IDEMPOTENCY_OUTCOME_UNKNOWN`: the caller reads the session's state and
 * events and decides, and uses a new key if it retries.
 */
// Consumed by foreman.routes.ts for every call that changes a session.
export function createForemanIdempotency(dependencies: { storage: ForemanIdempotencyStorage; now?: () => Date }) {
  const { storage } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const running = new Map<string, Promise<IdempotentAnswer>>();

  async function execute(key: string, run: () => Promise<IdempotentAnswer>): Promise<IdempotentAnswer> {
    try {
      const answer = await run();
      storage.complete(key, answer.status, JSON.stringify(answer.body));
      return answer;
    } catch (error) {
      storage.release(key);
      throw error;
    }
  }

  return {
    async once(call: { key: string; operation: string; fingerprint: string }, run: () => Promise<IdempotentAnswer>): Promise<IdempotentAnswer> {
      const existing = storage.get(call.key);
      if (existing) {
        if (existing.operation !== call.operation || existing.fingerprint !== call.fingerprint) {
          throw new AppError('This idempotency key was used for a different call.', { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 422 });
        }
        if (existing.state === 'done') {
          return { status: existing.status_code ?? 200, body: JSON.parse(existing.response_json ?? 'null') as unknown };
        }
        const first = running.get(call.key);
        if (first) {
          return first;
        }
        throw new AppError('The call with this idempotency key began and its outcome is unknown: read the session state and events, and use a new key to try again.', {
          code: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
          statusCode: 409,
        });
      }
      storage.begin(call.key, call.operation, call.fingerprint, now().toISOString());
      const first = execute(call.key, run);
      running.set(call.key, first);
      try {
        return await first;
      } finally {
        running.delete(call.key);
      }
    },
  };
}

export type ForemanIdempotency = ReturnType<typeof createForemanIdempotency>;

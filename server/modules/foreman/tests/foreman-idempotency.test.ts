import assert from 'node:assert/strict';
import test from 'node:test';

import type { ForemanIdempotencyRow } from '@/modules/database/index.js';
import { createForemanIdempotency, fingerprintOf, type ForemanIdempotencyStorage } from '@/modules/foreman/foreman-idempotency.service.js';
import { AppError } from '@/shared/utils.js';

function memoryStorage(rows = new Map<string, ForemanIdempotencyRow>()): ForemanIdempotencyStorage & { rows: typeof rows } {
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    begin: (key, operation, fingerprint, createdAt) => void rows.set(key, { key, operation, fingerprint, state: 'pending', status_code: null, response_json: null, created_at: createdAt }),
    complete(key, status, json) {
      const row = rows.get(key);
      if (row) rows.set(key, { ...row, state: 'done', status_code: status, response_json: json });
    },
    release: (key) => void rows.delete(key),
  };
}

const call = { key: 'start:run-1:1', operation: 'start', fingerprint: fingerprintOf({ a: 1 }) };

test('a call with a new key runs once, and a repeat gets the first answer without running again', async () => {
  const idempotency = createForemanIdempotency({ storage: memoryStorage() });
  let runs = 0;
  const run = async () => ({ status: 201, body: { sessionId: `session-${(runs += 1)}` } });
  const first = await idempotency.once(call, run);
  const again = await idempotency.once(call, run);
  assert.deepEqual(first, { status: 201, body: { sessionId: 'session-1' } });
  assert.deepEqual(again, first);
  assert.equal(runs, 1);
});

test('a repeat that arrives while the first call is still running waits for it', async () => {
  const idempotency = createForemanIdempotency({ storage: memoryStorage() });
  let runs = 0;
  let finish: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const run = async () => { runs += 1; await gate; return { status: 200, body: { ok: true } }; };
  const first = idempotency.once(call, run);
  const second = idempotency.once(call, run);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }]);
  assert.equal(runs, 1);
});

test('a call that fails releases its key, so a retry runs', async () => {
  const idempotency = createForemanIdempotency({ storage: memoryStorage() });
  await assert.rejects(idempotency.once(call, async () => { throw new AppError('no', { code: 'NOPE', statusCode: 409 }); }), /no/);
  assert.deepEqual(await idempotency.once(call, async () => ({ status: 200, body: 'second try' })), { status: 200, body: 'second try' });
});

test('the same key for a different call is refused', async () => {
  const idempotency = createForemanIdempotency({ storage: memoryStorage() });
  await idempotency.once(call, async () => ({ status: 200, body: 1 }));
  await assert.rejects(idempotency.once({ ...call, fingerprint: fingerprintOf({ a: 2 }) }, async () => ({ status: 200, body: 2 })), (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_KEY_REUSED' && error.statusCode === 422);
  await assert.rejects(idempotency.once({ ...call, operation: 'message' }, async () => ({ status: 200, body: 2 })), /different call/);
});

test('a call that began in a process that died is refused as unknown, never run a second time', async () => {
  const rows = new Map<string, ForemanIdempotencyRow>();
  let ran = false;
  // The first process claims the key and dies before it answers.
  memoryStorage(rows).begin(call.key, call.operation, call.fingerprint, 'earlier');
  const restarted = createForemanIdempotency({ storage: memoryStorage(rows) });
  await assert.rejects(restarted.once(call, async () => { ran = true; return { status: 200, body: null }; }), (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_OUTCOME_UNKNOWN' && error.statusCode === 409);
  assert.equal(ran, false);
});

test('an answer survives a restart: a new service over the same storage returns it', async () => {
  const rows = new Map<string, ForemanIdempotencyRow>();
  await createForemanIdempotency({ storage: memoryStorage(rows) }).once(call, async () => ({ status: 202, body: { accepted: true } }));
  let ran = false;
  const again = await createForemanIdempotency({ storage: memoryStorage(rows) }).once(call, async () => { ran = true; return { status: 500, body: null }; });
  assert.deepEqual(again, { status: 202, body: { accepted: true } });
  assert.equal(ran, false);
});

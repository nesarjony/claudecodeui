import assert from 'node:assert/strict';
import test from 'node:test';

import { row, startBody, tick, withBridge, type World } from './foreman-routes-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * Every call that changes a session carries an `idempotencyKey` and applies it at most once: a repeat of the same call gets the first
 * answer back and runs nothing, the same key for another call is refused, and a call that failed leaves its key free.
 */

/** A session Foreman started, with a run, a live process and a pending prompt: every changing call below has something to act on. */
function addBusySession(world: World, sessionId = 's1') {
  world.rows.set(sessionId, row({ session_id: sessionId, model: 'claude-sonnet-5-5@cap' }));
  world.processing.add(sessionId);
  world.approvals.set(sessionId, [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' }, receivedAt: new Date() }]);
}

// ---------------------------------------------------------------------------------------------
// The key is required
// ---------------------------------------------------------------------------------------------

test('every call that changes a session needs a well formed idempotencyKey, and without one nothing happens', async () => {
  await withBridge(async ({ call, world }) => {
    addBusySession(world);
    world.addOwnerSession('owner');
    world.addOwnerSession('handed-over');
    assert.equal((await call('POST', '/sessions/handed-over/adopt', {})).status, 200);
    const keysBefore = world.idempotencyStorage.rows.size;
    const settledBefore = world.settleCalls;

    const changing: Array<[string, Record<string, unknown>]> = [
      ['/sessions', startBody()],
      ['/sessions/s1/message', { text: 'hi', interrupt: true }],
      ['/sessions/s1/interrupt', {}],
      ['/sessions/s1/model', { model: 'opus' }],
      ['/sessions/s1/compact', {}],
      ['/sessions/s1/permission', { requestId: 'req-1', decision: 'allow' }],
      ['/sessions/owner/adopt', {}],
      ['/sessions/handed-over/release', {}],
    ];
    const badKeys: unknown[] = [undefined, null, '', 42, true, 'has space', '-leading-dash', 'x'.repeat(201), ['k'], { key: 'k' }];
    for (const [pathname, body] of changing) {
      for (const idempotencyKey of badKeys) {
        const response = await call('POST', pathname, { ...body, idempotencyKey });
        assert.equal(response.status, 400, `${pathname} with ${JSON.stringify(idempotencyKey) ?? 'no key'}`);
        assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED', pathname);
      }
    }

    // None of the refused calls did anything, and none of them claimed a key.
    assert.equal(world.created.length, 0);
    assert.equal(world.startedTurns.length, 0);
    assert.deepEqual(world.aborted, []);
    assert.deepEqual(world.resolvedPermissions, []);
    assert.deepEqual(world.modelChanges, []);
    assert.equal(world.settleCalls, settledBefore);
    assert.equal(world.state.get('owner'), null, 'the owner\'s session was not adopted');
    assert.equal(world.state.get('handed-over')?.supervision, 'adopted', 'and the adopted one was not released');
    assert.equal(world.idempotencyStorage.rows.size, keysBefore);
  });
});

test('a key may use letters, digits and . _ : - up to 200 characters', async () => {
  await withBridge(async ({ call, world }) => {
    world.addOwnerSession('owner');
    for (const idempotencyKey of ['start:run-1:1', 'A.b_c-d:e', 'x'.repeat(200)]) {
      const response = await call('POST', '/sessions/owner/adopt', { idempotencyKey });
      assert.ok(response.status === 200 || response.status === 409, `${idempotencyKey.slice(0, 20)} -> ${response.status}`);
      assert.notEqual(response.body.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

test('the same key and body on POST /sessions starts exactly one session, and the repeat answers as the first did', async () => {
  await withBridge(async ({ call, world }) => {
    const body = startBody({ taskId: 'task-1', idempotencyKey: 'start:run-1:1' });
    const first = await call('POST', '/sessions', body);
    const repeat = await call('POST', '/sessions', body);

    assert.equal(first.status, 201);
    assert.equal(repeat.status, 201);
    assert.deepEqual(repeat.body, first.body);
    assert.equal(repeat.body.data.sessionId, first.body.data.sessionId);

    assert.equal(world.created.length, 1, 'one session allocated');
    assert.equal(world.startedTurns.length, 1, 'one turn');
    assert.deepEqual(world.managedMarks, [first.body.data.sessionId]);
    assert.equal(world.headCalls.length, 1);
    assert.equal(world.stateRows.size, 1);
    assert.equal(world.idempotencyStorage.rows.get('start:run-1:1')?.state, 'done');
    assert.equal(world.idempotencyStorage.rows.get('start:run-1:1')?.status_code, 201);
  });
});

test('two identical starts that arrive together still start one session', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = () => new Promise((resolve) => setTimeout(() => resolve({ started: true, error: null }), 150));
    const body = startBody({ idempotencyKey: 'start:run-2:1' });
    const [a, b] = await Promise.all([call('POST', '/sessions', body), call('POST', '/sessions', body)]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.body.data.sessionId, b.body.data.sessionId);
    assert.equal(world.created.length, 1);
    assert.equal(world.startedTurns.length, 1);
  });
});

test('the same key for a different start, or for another kind of call, is refused with IDEMPOTENCY_KEY_REUSED and runs nothing', async () => {
  await withBridge(async ({ call, world }) => {
    const key = 'start:run-3:1';
    const first = await call('POST', '/sessions', startBody({ idempotencyKey: key }));
    assert.equal(first.status, 201);
    const sessionId = first.body.data.sessionId as string;

    const different: Array<[string, Record<string, unknown>]> = [
      ['another prompt', startBody({ prompt: 'Do something else' })],
      ['another project', startBody({ projectPath: '/mnt/dev/other' })],
      ['another sandbox', startBody({ sandbox: samplePolicy({ scratchDir: '/mnt/dev/scratch/other' }) })],
      ['another billing', startBody({ billing: 'subscription' })],
    ];
    for (const [label, body] of different) {
      const response = await call('POST', '/sessions', { ...body, idempotencyKey: key });
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED', label);
    }
    const asMessage = await call('POST', `/sessions/${sessionId}/message`, { text: 'hi', idempotencyKey: key });
    assert.equal(asMessage.status, 422);
    assert.equal(asMessage.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

    assert.equal(world.created.length, 1);
    assert.equal(world.startedTurns.length, 1);
    // The first answer is still what the key stands for.
    assert.equal((await call('POST', '/sessions', startBody({ idempotencyKey: key }))).body.data.sessionId, sessionId);
  });
});

test('a start that failed does not burn its key: the retry with the same key runs', async () => {
  await withBridge(async ({ call, world }) => {
    const key = 'start:run-4:1';
    world.turnOutcome = async () => ({ started: false, error: 'Provider "claude" is not available.' });
    const failed = await call('POST', '/sessions', startBody({ idempotencyKey: key }));
    assert.equal(failed.status, 502);
    assert.equal(world.idempotencyStorage.rows.has(key), false, 'an error answer is not stored');

    world.turnOutcome = async () => ({ started: true, error: null });
    const retry = await call('POST', '/sessions', startBody({ idempotencyKey: key }));
    assert.equal(retry.status, 201);
    assert.equal(world.startedTurns.length, 2, 'the retry ran in full');
    assert.equal(world.idempotencyStorage.rows.get(key)?.state, 'done');

    // And now it is applied: a third try gets the retry's answer.
    const again = await call('POST', '/sessions', startBody({ idempotencyKey: key }));
    assert.deepEqual(again.body, retry.body);
    assert.equal(world.startedTurns.length, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Message, compact, model
// ---------------------------------------------------------------------------------------------

test('the same key and body on a message runs one turn, and a different text under that key is refused', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet@cap' }));
    const body = { text: 'Now add tests', idempotencyKey: 'message:task-1:1' };
    const first = await call('POST', '/sessions/s1/message', body);
    const repeat = await call('POST', '/sessions/s1/message', body);
    assert.equal(first.status, 202);
    assert.equal(repeat.status, 202);
    assert.deepEqual(repeat.body, first.body);
    assert.equal(world.startedTurns.length, 1);

    const reused = await call('POST', '/sessions/s1/message', { text: 'Something else', idempotencyKey: body.idempotencyKey });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    // The same body for another session is another call too.
    world.rows.set('s2', row({ session_id: 's2' }));
    assert.equal((await call('POST', '/sessions/s2/message', body)).status, 422);
    assert.equal(world.startedTurns.length, 1);
  });
});

test('a message that failed does not burn its key, and neither does one for a session that is not there yet', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    const body = { text: 'steer', idempotencyKey: 'message:task-1:2' };
    const busy = await call('POST', '/sessions/s1/message', body);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'RUN_IN_PROGRESS');
    assert.equal(world.idempotencyStorage.rows.has(body.idempotencyKey), false);
    assert.equal(world.startedTurns.length, 0);

    world.processing.clear();
    const retry = await call('POST', '/sessions/s1/message', body);
    assert.equal(retry.status, 202);
    assert.equal(world.startedTurns.length, 1);
    assert.equal(world.idempotencyStorage.rows.get(body.idempotencyKey)?.state, 'done');

    const early = { text: 'hello', idempotencyKey: 'message:task-2:1' };
    assert.equal((await call('POST', '/sessions/later/message', early)).status, 404);
    world.rows.set('later', row({ session_id: 'later' }));
    await tick();
    assert.equal((await call('POST', '/sessions/later/message', early)).status, 202);
  });
});

test('the same key on compact runs one /compact turn, and on a model change records the model once', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-sonnet-5-5@cap' }));
    const compact = { instructions: 'Keep the notes.', idempotencyKey: 'compact:task-1:1' };
    const first = await call('POST', '/sessions/s1/compact', compact);
    const repeat = await call('POST', '/sessions/s1/compact', compact);
    assert.equal(first.status, 202);
    assert.deepEqual(repeat.body, first.body);
    assert.deepEqual(world.startedTurns.map((turn) => turn.content), ['/compact Keep the notes.']);

    const model = { model: 'claude-opus-5-5', idempotencyKey: 'model:task-1:1' };
    const switched = await call('POST', '/sessions/s1/model', model);
    const again = await call('POST', '/sessions/s1/model', model);
    assert.equal(switched.status, 200);
    assert.deepEqual(again.body, switched.body);
    assert.deepEqual(world.modelChanges, [{ sessionId: 's1', model: 'claude-opus-5-5@cap' }]);
    assert.equal((await call('POST', '/sessions/s1/model', { model: 'sonnet', idempotencyKey: model.idempotencyKey })).status, 422);
    assert.equal(world.modelChanges.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Interrupt and permission
// ---------------------------------------------------------------------------------------------

test('the same key on interrupt aborts once, and the repeat is told what the first call did instead of finding nothing to stop', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    const body = { idempotencyKey: 'interrupt:task-1:1' };
    const first = await call('POST', '/sessions/s1/interrupt', body);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, { sessionId: 's1', interrupted: true, wasRunning: true, hadLiveProcess: false });

    // Without the key a second interrupt would find no run and answer 409 NOT_RUNNING.
    const repeat = await call('POST', '/sessions/s1/interrupt', body);
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body, first.body);
    assert.deepEqual(world.aborted, ['s1']);
    assert.equal(world.completedRuns.length, 1);

    const fresh = await call('POST', '/sessions/s1/interrupt', {});
    assert.equal(fresh.status, 409, 'a new key is a new call');
    assert.equal(fresh.body.error.code, 'NOT_RUNNING');
  });
});

test('the same key on a permission answer resolves the prompt once, and the repeat does not 404, and another decision is refused', async () => {
  await withBridge(async ({ call, world }) => {
    addBusySession(world);
    const body = { requestId: 'req-1', decision: 'deny', reason: 'Not in this task.', idempotencyKey: 'permission:req-1' };
    const first = await call('POST', '/sessions/s1/permission', body);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, { resolved: true });

    // The prompt is gone, so a call with a new key finds nothing pending; the repeat of the first is answered from the key.
    const repeat = await call('POST', '/sessions/s1/permission', body);
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body, first.body);
    assert.deepEqual(world.resolvedPermissions, [{ requestId: 'req-1', decision: { allow: false, message: 'Not in this task.' } }]);
    assert.equal((await call('POST', '/sessions/s1/permission', { requestId: 'req-1', decision: 'deny' })).status, 404);

    const other = await call('POST', '/sessions/s1/permission', { requestId: 'req-1', decision: 'allow', idempotencyKey: body.idempotencyKey });
    assert.equal(other.status, 422);
    assert.equal(other.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(world.resolvedPermissions.length, 1, 'the prompt is not answered a second time with the other decision');
  });
});

test('an answer to a prompt that is not pending does not burn its key', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    const body = { requestId: 'req-late', decision: 'allow', idempotencyKey: 'permission:req-late' };
    assert.equal((await call('POST', '/sessions/s1/permission', body)).status, 404);
    assert.equal(world.idempotencyStorage.rows.has(body.idempotencyKey), false);

    world.approvals.set('s1', [{ requestId: 'req-late', toolName: 'Bash', input: {}, receivedAt: new Date() }]);
    assert.equal((await call('POST', '/sessions/s1/permission', body)).status, 200);
    assert.equal(world.resolvedPermissions.length, 1);
  });
});

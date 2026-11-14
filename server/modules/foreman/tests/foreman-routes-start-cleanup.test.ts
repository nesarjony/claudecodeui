import assert from 'node:assert/strict';
import test from 'node:test';

import { startBody, withBridge, type Call, type World } from './foreman-routes-support.js';

/**
 * A start that fails after its session was created leaves no session behind: the failure is answered as before, and the session is marked
 * failed, no longer supervised, without its task link or worker mark, never announced, and deleted (no run made a transcript) or archived
 * (one did), so nothing lists it and nothing drives it.
 */

async function leftNothingBehind(world: World, call: Call, sessionId: string, how: 'delete' | 'archive'): Promise<void> {
  const state = world.state.get(sessionId);
  assert.deepEqual([state?.status, state?.supervision], ['error', 'released'], 'marked failed and unsupervised');
  assert.equal(world.state.listSupervised().some((entry) => entry.sessionId === sessionId), false, 'not supervised');
  assert.deepEqual(world.removed, [{ sessionId, how }]);
  assert.equal(how === 'delete' ? world.rows.has(sessionId) : world.rows.get(sessionId)?.isArchived, how === 'delete' ? false : 1);
  const listed = (await call('GET', '/sessions')).body.data.sessions as Array<{ id: string }>;
  assert.equal(listed.some((entry) => entry.id === sessionId), false, 'not listed');
  assert.deepEqual(world.managedMarks, [], 'no worker mark');
  assert.equal(world.taskStore.size, 0, 'no task link');
  assert.deepEqual(world.announced, [], 'never announced');
  const message = await call('POST', `/sessions/${sessionId}/message`, { text: 'carry on' });
  assert.ok([404, 409].includes(message.status), 'nothing drives it');
}

test('a start whose sandbox is not recorded answers SANDBOX_NOT_RECORDED and deletes the session it made', async () => {
  await withBridge(async ({ call, world }) => {
    const stored = world.stateStore.upsert;
    world.stateStore.upsert = (row) => stored({ ...row, sandbox_json: null });
    const response = await call('POST', '/sessions', startBody({ taskId: 'task-1' }));
    assert.deepEqual([response.status, response.body.error.code], [500, 'SANDBOX_NOT_RECORDED']);
    assert.equal(world.startedTurns.length, 0);
    await leftNothingBehind(world, call, 'new-1', 'delete');
  });
});

test('a start whose sandbox cannot be written at all deletes the session too', async () => {
  await withBridge(async ({ call, world }) => {
    world.stateStore.upsert = () => {
      throw new Error('database is locked');
    };
    const response = await call('POST', '/sessions', startBody());
    assert.deepEqual([response.status, response.body.error.code], [500, 'SANDBOX_NOT_RECORDED']);
    assert.match(response.body.error.message, /database is locked/);
    await leftNothingBehind(world, call, 'new-1', 'delete');
  });
});

test('a turn refused before it ran deletes the session; a turn that failed after the CLI made a transcript archives it', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => ({ started: false, error: 'Provider "claude" is not available.' });
    const refused = await call('POST', '/sessions', startBody({ taskId: 'task-2' }));
    assert.deepEqual([refused.status, refused.body.error.code], [502, 'TURN_START_FAILED']);
    await leftNothingBehind(world, call, 'new-1', 'delete');
  });
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => {
      // The CLI got as far as its first message: the session has a transcript now.
      const row = world.rows.get('new-1');
      if (row) row.provider_session_id = 'prov-new-1';
      return { started: true, error: 'the CLI exited with code 1' };
    };
    const failed = await call('POST', '/sessions', startBody({ taskId: 'task-3' }));
    assert.deepEqual([failed.status, failed.body.error.code], [502, 'TURN_START_FAILED']);
    await leftNothingBehind(world, call, 'new-1', 'archive');
  });
});

test('a start that throws anywhere after the session was made is answered as before and leaves nothing behind', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => {
      throw new Error('spawn failed');
    };
    const crashed = await call('POST', '/sessions', startBody());
    assert.deepEqual([crashed.status, crashed.body.error.code], [502, 'TURN_START_FAILED']);
    await leftNothingBehind(world, call, 'new-1', 'delete');
  });
  await withBridge(async ({ call, world, deps }) => {
    deps.sessionsDb.updateSessionCustomName = () => {
      throw new Error('disk full');
    };
    const thrown = await call('POST', '/sessions', startBody({ title: 'A title' }));
    assert.equal(thrown.status, 500);
    assert.equal(world.startedTurns.length, 0);
    await leftNothingBehind(world, call, 'new-1', 'delete');
  });
});

test('a failed start leaves the key free and a retry starts one session; a clean-up step that fails is logged, not answered', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => ({ started: false, error: 'not available' });
    const body = startBody({ idempotencyKey: 'start:run-1:1' });
    assert.equal((await call('POST', '/sessions', body)).status, 502);
    world.turnOutcome = async () => ({ started: true, error: null });
    const retried = await call('POST', '/sessions', body);
    assert.equal(retried.status, 201);
    const listed = (await call('GET', '/sessions')).body.data.sessions as Array<{ id: string }>;
    assert.deepEqual(listed.map((entry) => entry.id), [retried.body.data.sessionId]);

    world.turnOutcome = async () => ({ started: false, error: 'not available' });
    world.removeError = new Error('database is locked');
    const failed = await call('POST', '/sessions', startBody());
    assert.deepEqual([failed.status, failed.body.error.code], [502, 'TURN_START_FAILED'], 'the answer is the start\'s own failure');
    assert.ok(world.logged.some((line) => /failed start of session new-3: removing it failed: database is locked/.test(line)), world.logged.join('\n'));
    assert.equal(world.state.get('new-3')?.supervision, 'released', 'the other steps still ran');
  });
});

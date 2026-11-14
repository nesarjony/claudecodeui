import assert from 'node:assert/strict';
import test from 'node:test';

import { startBody, tick, withBridge, type World } from './foreman-routes-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * A session start records its sandbox with a write that throws when it fails, and reads it back the way the session's runs will, before
 * anything runs: a start whose policy is not exactly what its runs will find fails, and nothing is dispatched.
 */

function refusedAsNotRecorded(response: { status: number; body: any }, world: World): void {
  assert.equal(response.status, 500);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, 'SANDBOX_NOT_RECORDED');
  assert.equal(response.body.data, undefined, 'no answer says sandboxed: true');
  assert.equal(world.startedTurns.length, 0, 'nothing was dispatched');
}

test('a start whose sandbox cannot be written fails with SANDBOX_NOT_RECORDED and dispatches nothing', async () => {
  await withBridge(async ({ call, world }) => {
    world.stateStore.upsert = () => {
      throw new Error('database is locked');
    };
    const response = await call('POST', '/sessions', startBody());
    refusedAsNotRecorded(response, world);
    assert.match(response.body.error.message, /database is locked/);
    assert.equal(world.state.get('new-1')?.supervision, 'released', 'the session it made is not supervised (see foreman-routes-start-cleanup.test.ts)');
  });
});

test('a start whose sandbox is written but reads back as something else fails too, and dispatches nothing', async () => {
  await withBridge(async ({ call, world }) => {
    const stored = world.stateStore.upsert;
    const other = samplePolicy({ scratchDir: '/mnt/dev/scratch/other' });
    world.stateStore.upsert = (row) => stored({ ...row, sandbox_json: JSON.stringify(other) });
    refusedAsNotRecorded(await call('POST', '/sessions', startBody()), world);

    world.stateStore.upsert = (row) => stored({ ...row, sandbox_json: null });
    refusedAsNotRecorded(await call('POST', '/sessions', startBody()), world);

    world.stateStore.upsert = () => undefined;
    refusedAsNotRecorded(await call('POST', '/sessions', startBody()), world);
  });
});

test('a start may write only its project, its scratch directory and its git directory, and the scope is stored with the policy', async () => {
  await withBridge(async ({ call, world }) => {
    world.gitCommonDir = '/mnt/dev/main/.git';
    const writing = (allowWrite: string[]) => samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowWrite } });
    for (const outside of ['/mnt/dev/other', '/home/worker/.gitconfig', '/mnt/dev/known-other']) {
      const refused = await call('POST', '/sessions', startBody({ sandbox: writing([outside]) }));
      assert.deepEqual([refused.status, refused.body.error.code], [400, 'SANDBOX_INVALID'], outside);
      assert.match(refused.body.error.message, /outside the project, scratchDir and the git directory|home directory/, outside);
    }
    assert.equal(world.created.length, 0, 'nothing was allocated');

    const sandbox = writing(['/mnt/dev/known/src', '/mnt/dev/main/.git', '/mnt/dev/scratch/batch-1']);
    const started = await call('POST', '/sessions', startBody({ sandbox }));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const stored = world.stateRows.get(started.body.data.sessionId as string);
    assert.deepEqual(JSON.parse(stored?.sandbox_scope_json ?? 'null'), { projectPath: '/mnt/dev/known', gitCommonDir: '/mnt/dev/main/.git' });
    assert.deepEqual(world.state.sandboxOf(started.body.data.sessionId as string), { policy: sandbox });
  });
});

test('every turn of a session Foreman started is marked as sandboxed; a turn of a session handed over is not', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    const started = await call('POST', '/sessions', startBody());
    const sessionId = started.body.data.sessionId as string;
    await tick();
    await call('POST', `/sessions/${sessionId}/message`, { text: 'go on' });
    await tick();
    await call('POST', `/sessions/${sessionId}/compact`, {});
    assert.deepEqual(world.startedTurns.map((turn) => turn.options.foremanSandbox), [true, true, true]);

    world.addOwnerSession('owner');
    await handOver('owner');
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
    assert.equal((await call('POST', '/sessions/owner/message', { text: 'hello' })).status, 202);
    assert.equal('foremanSandbox' in (world.startedTurns.at(-1)?.options ?? {}), false, 'the owner\'s session runs as the owner set it up');
  });
});

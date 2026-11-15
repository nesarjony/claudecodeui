import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';

import { createBridgeServices, startBody, tick, withBridge, type Call } from './foreman-routes-support.js';

/**
 * A sandboxed session never runs in `bypassPermissions` or `auto`: the sandbox covers Bash only, and the file tools rely on the prompts
 * those modes skip. Every session Foreman starts is sandboxed, so a start, a message and a compact refuse both modes.
 */

const FORBIDDEN = ['bypassPermissions', 'auto'];
const ALLOWED = ['default', 'acceptEdits', 'plan'];

async function startedSession(call: Call): Promise<string> {
  const started = await call('POST', '/sessions', startBody({ permissionMode: 'acceptEdits' }));
  assert.equal(started.status, 201);
  await tick();
  return started.body.data.sessionId as string;
}

test('a start in bypassPermissions or auto is refused with PERMISSION_MODE_FORBIDDEN, and nothing is made', async () => {
  await withBridge(async ({ call, world }) => {
    for (const permissionMode of FORBIDDEN) {
      const response = await call('POST', '/sessions', startBody({ permissionMode }));
      assert.equal(response.status, 400, permissionMode);
      assert.equal(response.body.error.code, 'PERMISSION_MODE_FORBIDDEN', permissionMode);
      assert.match(response.body.error.message, /default, acceptEdits, plan/);
    }
    assert.deepEqual(world.created, [], 'no session was allocated');
    assert.equal(world.startedTurns.length, 0);
    assert.equal(world.stateRows.size, 0);
    assert.equal(world.idempotencyStorage.rows.size, 0, 'a refused call does not use up its key');
  });
});

test('a message or a compact in bypassPermissions or auto is refused for a session Foreman started, and its mode stays', async () => {
  await withBridge(async ({ call, world }) => {
    const sessionId = await startedSession(call);
    for (const permissionMode of FORBIDDEN) {
      const message = await call('POST', `/sessions/${sessionId}/message`, { text: 'go on', permissionMode });
      assert.equal(message.status, 400, permissionMode);
      assert.equal(message.body.error.code, 'PERMISSION_MODE_FORBIDDEN');
      const compact = await call('POST', `/sessions/${sessionId}/compact`, { permissionMode });
      assert.equal(compact.status, 400, permissionMode);
      assert.equal(compact.body.error.code, 'PERMISSION_MODE_FORBIDDEN');
    }
    assert.equal(world.startedTurns.length, 1, 'only the start ran');
    assert.equal(world.state.get(sessionId)?.permissionMode, 'acceptEdits');
  });
});

test('default, acceptEdits and plan are accepted on a start, a message and a compact', async () => {
  await withBridge(async ({ call, world }) => {
    for (const permissionMode of ALLOWED) {
      const started = await call('POST', '/sessions', startBody({ permissionMode }));
      assert.equal(started.status, 201, permissionMode);
      assert.equal(world.startedTurns.at(-1)?.options.permissionMode, permissionMode);
      const sessionId = started.body.data.sessionId as string;
      await tick();
      const message = await call('POST', `/sessions/${sessionId}/message`, { text: 'go on', permissionMode });
      assert.equal(message.status, 202, permissionMode);
      await tick();
      const compact = await call('POST', `/sessions/${sessionId}/compact`, { permissionMode });
      assert.equal(compact.status, 202, permissionMode);
      assert.equal(world.startedTurns.at(-1)?.options.permissionMode, permissionMode);
      assert.equal(world.state.get(sessionId)?.permissionMode, permissionMode);
    }
  });
});

test('a forbidden mode stored before this rule is not resumed: after a restart the next run gets no mode, so the default', async () => {
  await withBridge(async ({ call, world, deps }) => {
    const sessionId = await startedSession(call);
    const stored = world.stateRows.get(sessionId);
    assert.ok(stored);
    world.stateRows.set(sessionId, { ...stored, permission_mode: 'bypassPermissions' });

    // "Restart": a brand-new bridge over the same store.
    const restartedState = createForemanSessionStateService({ store: world.stateStore });
    const restarted = createBridgeServices({ ...deps, state: restartedState });
    assert.equal(restartedState.get(sessionId)?.permissionMode, null);
    await restarted.sessions.sendMessage(sessionId, { text: 'Carry on', interrupt: false });
    assert.equal(world.startedTurns.at(-1)?.options.permissionMode, undefined);
  });
});

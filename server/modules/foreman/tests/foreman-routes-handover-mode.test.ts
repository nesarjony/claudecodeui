import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';
import { createForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';

import { createMemoryRunModeStore, runStarted } from './foreman-handover-support.js';
import { createBridgeServices, tick, withBridge, type World } from './foreman-routes-support.js';

/**
 * The owner's mode survives the hand-over: cloudcli records the mode every session's last run started in (the owner's own too), adopt takes
 * it, and every turn Foreman sends to the adopted session runs in exactly that mode, never in a default of the bridge's.
 */

const addOwner = (world: World, sessionId = 'owner') => world.addOwnerSession(sessionId, { model: 'claude-opus-5-5', effort: 'high' });

const modeOf = (modes: ReturnType<typeof createForemanRunModes>, sessionId: string) => modes.settingsOf(sessionId)?.settings.permissionMode ?? null;

test('the mode of every session\'s last run is recorded, the owner\'s own included, the next run overwrites it, and nothing else is recorded', () => {
  const store = createMemoryRunModeStore();
  let clock = new Date('2026-11-14T09:00:00.000Z');
  const modes = createForemanRunModes({ store, now: () => clock });
  modes.observe(runStarted('owner', 'acceptEdits'));
  modes.observe(runStarted('worker', 'default'));
  modes.observe(runStarted('owner', null));
  modes.observe(runStarted('', 'plan'));
  modes.observe({ kind: 'run_ended', sessionId: 'owner', projectPath: null, reason: 'completed' });
  assert.deepEqual([modeOf(modes, 'owner'), modeOf(modes, 'worker'), modeOf(modes, 'never-ran')], ['acceptEdits', 'default', null]);

  clock = new Date('2026-11-14T09:10:00.000Z');
  modes.observe(runStarted('owner', 'bypassPermissions', { allowedTools: ['Bash(git:*)'], disallowedTools: ['WebFetch'] }));
  assert.deepEqual(store.rows.get('owner'), {
    session_id: 'owner', permission_mode: 'bypassPermissions', seen_at: '2026-11-14T09:10:00.000Z',
    tools_json: JSON.stringify({ allowedTools: ['Bash(git:*)'], disallowedTools: ['WebFetch'] }),
  });
  assert.deepEqual(modes.settingsOf('owner'), {
    settings: { permissionMode: 'bypassPermissions', allowedTools: ['Bash(git:*)'], disallowedTools: ['WebFetch'] },
    seenAt: '2026-11-14T09:10:00.000Z',
  });
  assert.equal(store.rows.size, 2);
});

test('a run the bridge dispatched is never recorded as the owner\'s, and a row without tools reads as unknown', () => {
  const store = createMemoryRunModeStore();
  const modes = createForemanRunModes({ store, now: () => new Date('2026-11-14T09:00:00.000Z') });
  modes.observe(runStarted('owner', 'plan', { disallowedTools: ['Bash'] }));
  modes.observe(runStarted('owner', 'bypassPermissions', { allowedTools: ['Bash'], foremanDispatch: true }));
  assert.deepEqual(modes.settingsOf('owner')?.settings, { permissionMode: 'plan', allowedTools: [], disallowedTools: ['Bash'] });
  modes.observe(runStarted('worker', 'default', { foremanDispatch: true }));
  assert.equal(store.rows.has('worker'), false);

  // As a row recorded before the tools were: the owner's tools are unknown, so a hand-over waits instead of guessing.
  store.rows.set('legacy', { session_id: 'legacy', permission_mode: 'default', seen_at: '2026-11-14T08:00:00.000Z', tools_json: null });
  store.rows.set('broken', { session_id: 'broken', permission_mode: 'default', seen_at: '2026-11-14T08:00:00.000Z', tools_json: '{"allowedTools":"Bash"}' });
  assert.deepEqual([modes.settingsOf('legacy'), modes.settingsOf('broken')], [null, null]);
});

test('a store that fails is logged and never throws into the runtime loop; a mode it cannot read is unknown', () => {
  const log: string[] = [];
  const modes = createForemanRunModes({
    store: { record: () => { throw new Error('disk I/O error'); }, get: () => { throw new Error('database is locked'); } },
    log: (message) => log.push(message),
  });
  assert.doesNotThrow(() => modes.observe(runStarted('owner', 'acceptEdits')));
  assert.equal(modes.settingsOf('owner'), null);
  assert.deepEqual(log, ['run mode of owner not recorded: disk I/O error', 'run mode of owner not read: database is locked']);
});

test('adopt takes the owner\'s last mode, and every turn Foreman sends runs in exactly that mode, after a restart too', async () => {
  await withBridge(async ({ call, world, handOver, deps }) => {
    addOwner(world);
    world.ownerRan('owner', 'default');
    world.ownerRan('owner', 'acceptEdits');
    await handOver('owner', null);

    const adopted = await call('POST', '/sessions/owner/adopt', {});
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.data.permissionMode, 'acceptEdits');
    assert.equal(world.state.get('owner')?.permissionMode, 'acceptEdits');

    assert.equal((await call('POST', '/sessions/owner/message', { text: 'Carry on' })).status, 202);
    await tick();
    assert.equal((await call('POST', '/sessions/owner/compact', {})).status, 202);
    await tick();
    // A restarted cloudcli reads the adopted session's mode back from the stored state.
    const restarted = createBridgeServices({ ...deps, state: createForemanSessionStateService({ store: world.stateStore }) });
    await restarted.sessions.sendMessage('owner', { text: 'After the restart', interrupt: false });

    assert.deepEqual(world.startedTurns.map((turn) => [turn.content, turn.options.permissionMode]), [
      ['Carry on', 'acceptEdits'],
      ['/compact', 'acceptEdits'],
      ['After the restart', 'acceptEdits'],
    ]);
  });
});

test('an owner\'s bypassPermissions is the owner\'s choice and is kept: Foreman neither widens nor narrows the mode', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world);
    await handOver('owner', 'bypassPermissions');
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).body.data.permissionMode, 'bypassPermissions');

    const narrowed = await call('POST', '/sessions/owner/message', { text: 'go', permissionMode: 'default' });
    assert.deepEqual([narrowed.status, narrowed.body.error.code], [400, 'PERMISSION_MODE_LOCKED']);
    assert.equal((await call('POST', '/sessions/owner/message', { text: 'go' })).status, 202);
    assert.equal(world.startedTurns.length, 1);
    assert.equal(world.startedTurns[0].options.permissionMode, 'bypassPermissions');
    assert.equal('foremanSandbox' in world.startedTurns[0].options, false, 'no sandbox: the session is the owner\'s');
  });
});

test('without a recorded mode adopt is 409 PERMISSION_MODE_UNKNOWN, changes nothing and keeps the grant; after one turn of the owner it adopts', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world);
    await handOver('owner', null);

    const refused = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'PERMISSION_MODE_UNKNOWN');
    assert.match(refused.body.error.message, /owner sends one turn/);
    assert.equal(world.state.get('owner'), null);
    assert.deepEqual(world.headCalls, []);
    assert.equal(world.grantRows.has('owner'), true, 'the grant is not used up');
    assert.equal(world.idempotencyStorage.rows.size, 0, 'and the key stays free');

    world.ownerRan('owner', 'acceptEdits');
    const adopted = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' });
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.data.permissionMode, 'acceptEdits');
    assert.equal(world.grantRows.size, 0);
  });
});

test('a session adopted before the owner\'s mode was recorded is refused instead of running in the default, until it is handed over again', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world, 'legacy');
    // A row as an earlier cloudcli wrote it at adoption: no permission mode (or a mode and no tools).
    world.state.track('legacy', { supervision: 'adopted' });
    addOwner(world, 'tools-unknown');
    world.state.track('tools-unknown', { supervision: 'adopted', permissionMode: 'default' });
    const toolsUnknown = await call('POST', '/sessions/tools-unknown/message', { text: 'go' });
    assert.deepEqual([toolsUnknown.status, toolsUnknown.body.error.code], [409, 'PERMISSION_MODE_UNKNOWN'], 'adopted before its tools were stored');
    for (const [route, body] of [['message', { text: 'go' }], ['compact', {}]] as const) {
      const response = await call('POST', `/sessions/legacy/${route}`, body);
      assert.deepEqual([response.status, response.body.error.code], [409, 'PERMISSION_MODE_UNKNOWN'], route);
    }
    assert.equal(world.startedTurns.length, 0, 'nothing ran in the default');

    assert.equal((await call('POST', '/sessions/legacy/release', {})).status, 200);
    await handOver('legacy', 'plan');
    assert.equal((await call('POST', '/sessions/legacy/adopt', {})).status, 200);
    assert.equal((await call('POST', '/sessions/legacy/message', { text: 'go' })).status, 202);
    assert.equal(world.startedTurns[0].options.permissionMode, 'plan');
  });
});

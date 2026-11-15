import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';

import { createMemoryRunModeStore, runStarted } from './foreman-handover-support.js';
import { startBody, tick, withBridge, type Call, type World } from './foreman-routes-support.js';

/**
 * A turn sent while a session's CLI process is live (held open for background work) joins that process and runs with the settings that
 * started it. So a Foreman turn on an adopted session is refused while the live process was started with more than the owner now allows
 * (409 SETTINGS_WIDER_THAN_OWNERS), and nothing is dispatched; a process no wider, an idle session and a session Foreman started are not affected.
 */

const BASE_TOOLS = { allowedTools: ['Read', 'Grep'], disallowedTools: ['WebFetch'] };

const later = (world: World, minutes: number) => {
  world.clock = new Date(world.clock.getTime() + minutes * 60_000);
};

/** The owner hands over their session after a run in acceptEdits with BASE_TOOLS; Foreman adopts it. */
async function adoptOwnerSession(call: Call, world: World, handOver: (sessionId: string, permissionMode?: string | null) => Promise<void>) {
  world.addOwnerSession('owner');
  world.ownerRan('owner', 'acceptEdits', BASE_TOOLS);
  await handOver('owner', null);
  assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
  later(world, 1);
}

async function refused(call: Call, world: World, label: string): Promise<void> {
  const storedKeys = world.idempotencyStorage.rows.size;
  for (const [route, body] of [['message', { text: 'carry on' }], ['message', { text: 'carry on', interrupt: true }], ['compact', {}]] as const) {
    const response = await call('POST', `/sessions/owner/${route}`, body);
    assert.deepEqual([response.status, response.body.error?.code], [409, 'SETTINGS_WIDER_THAN_OWNERS'], `${label}: ${route} ${JSON.stringify(body)}`);
    assert.match(response.body.error.message, /retry once the process has ended, interrupt it first, or let the owner's run finish/i);
  }
  assert.deepEqual(world.startedTurns, [], `${label}: nothing was dispatched`);
  assert.deepEqual(world.aborted, [], `${label}: nothing was interrupted`);
  assert.equal(world.idempotencyStorage.rows.size, storedKeys, `${label}: a refused call leaves its key free`);
}

async function accepted(call: Call, world: World, label: string): Promise<void> {
  const response = await call('POST', '/sessions/owner/message', { text: 'carry on' });
  assert.equal(response.status, 202, `${label}: ${JSON.stringify(response.body)}`);
  await tick(10);
  // The turn carries the effective settings, whatever the process it joins was started with.
  assert.deepEqual(world.startedTurns.at(-1)?.options.toolsSettings, { ...BASE_TOOLS, skipPermissions: false }, label);
}

test('the owner\'s live process was started wider than the owner now allows: a Foreman turn is refused and nothing is dispatched', async () => {
  const wider: Array<[string, string, { allowedTools: string[]; disallowedTools: string[] }]> = [
    ['a wider mode', 'bypassPermissions', BASE_TOOLS],
    ['a tool more allowed', 'acceptEdits', { allowedTools: ['Read', 'Grep', 'Edit'], disallowedTools: ['WebFetch'] }],
    ['a tool less denied', 'acceptEdits', { allowedTools: ['Read', 'Grep'], disallowedTools: [] }],
    ['a mode outside the order', 'dontAsk', BASE_TOOLS],
  ];
  for (const [label, mode, tools] of wider) {
    await withBridge(async ({ call, world, handOver }) => {
      await adoptOwnerSession(call, world, handOver);
      // The owner ran the session again, wider than the base; Foreman's turns stay at the base, but the process holds the owner's settings.
      world.ownerRan('owner', mode, tools);
      world.live.add('owner');
      await refused(call, world, label);
      // Once the process has ended the same turn goes through, with the base.
      world.live.delete('owner');
      await accepted(call, world, `${label}, process ended`);
      assert.equal(world.startedTurns.at(-1)?.options.permissionMode, 'acceptEdits');
    });
  }
});

test('a live process whose settings this process never saw (a run recorded by an earlier one) is refused too', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    world.addOwnerSession('owner');
    world.runModeRows.set('owner', {
      session_id: 'owner', permission_mode: 'acceptEdits', seen_at: '2026-11-14T08:00:00.000Z', tools_json: JSON.stringify(BASE_TOOLS),
    });
    await handOver('owner', null);
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
    world.live.add('owner');
    await refused(call, world, 'unknown live run');
  });
});

test('a live process no wider than what the owner allows is joined: the same settings, narrower ones, or Foreman\'s own held turn', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    await adoptOwnerSession(call, world, handOver);
    world.live.add('owner');
    await accepted(call, world, 'the owner\'s process of the hand-over');

    // Foreman's own turn holds the process, started with the effective settings (listed in another order).
    world.runModes.observe(runStarted('owner', 'acceptEdits', { allowedTools: ['Grep', 'Read'], disallowedTools: ['WebFetch'], foremanDispatch: true }));
    await accepted(call, world, 'Foreman\'s own held process');

    // The owner narrows in a run of their own: Foreman's turns narrow with it, and the owner's process is no wider than that.
    later(world, 1);
    world.ownerRan('owner', 'plan', { allowedTools: ['Read'], disallowedTools: ['WebFetch', 'Bash'] });
    const response = await call('POST', '/sessions/owner/message', { text: 'carry on' });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await tick(10);
    assert.deepEqual(world.startedTurns.at(-1)?.options.toolsSettings, { allowedTools: ['Read'], disallowedTools: ['WebFetch', 'Bash'], skipPermissions: false });
    assert.equal(world.startedTurns.at(-1)?.options.permissionMode, 'plan');
  });
});

test('an idle session is not affected by how wide the owner\'s last run was', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    await adoptOwnerSession(call, world, handOver);
    world.ownerRan('owner', 'bypassPermissions', { allowedTools: ['Read', 'Grep', 'Edit', 'Write'], disallowedTools: [] });
    await accepted(call, world, 'idle');
    assert.equal(world.startedTurns.at(-1)?.options.permissionMode, 'acceptEdits', 'a new process with the base');
  });
});

test('a session Foreman started is not affected: its turns join its own held process', async () => {
  await withBridge(async ({ call, world }) => {
    const started = await call('POST', '/sessions', startBody());
    const sessionId = started.body.data.sessionId as string;
    await tick();
    world.runModes.observe(runStarted(sessionId, 'bypassPermissions', { allowedTools: ['Edit'], foremanDispatch: true }));
    world.live.add(sessionId);
    const response = await call('POST', `/sessions/${sessionId}/message`, { text: 'go on' });
    assert.equal(response.status, 202, JSON.stringify(response.body));
  });
});

test('the latest run of any origin is kept apart from the owner\'s last own run, in memory only', () => {
  const store = createMemoryRunModeStore();
  const modes = createForemanRunModes({ store, now: () => new Date('2026-11-14T09:00:00.000Z') });
  assert.equal(modes.latestRunOf('s1'), null);
  modes.observe(runStarted('s1', 'default', { allowedTools: ['Read'] }));
  modes.observe(runStarted('s1', 'bypassPermissions', { allowedTools: ['Edit'], disallowedTools: ['WebFetch'], foremanDispatch: true }));
  assert.deepEqual(modes.latestRunOf('s1'), { permissionMode: 'bypassPermissions', allowedTools: ['Edit'], disallowedTools: ['WebFetch'] });
  assert.deepEqual(modes.settingsOf('s1')?.settings, { permissionMode: 'default', allowedTools: ['Read'], disallowedTools: [] }, 'the bridge\'s run is not the owner\'s');
  modes.observe(runStarted('s1', null));
  assert.equal(modes.latestRunOf('s1'), null, 'a run whose mode is unknown leaves no older run standing for it');
  assert.equal(createForemanRunModes({ store }).latestRunOf('s1'), null, 'nothing of it is stored');
});

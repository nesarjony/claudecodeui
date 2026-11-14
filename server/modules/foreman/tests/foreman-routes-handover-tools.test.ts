import assert from 'node:assert/strict';
import test from 'node:test';

import { runStarted } from './foreman-handover-support.js';
import { startBody, tick, withBridge, type Call, type World } from './foreman-routes-support.js';

/**
 * Foreman never has a tool or mode the owner does not. Adopt stores the owner's mode and tool lists as the base; every Foreman turn carries
 * them as the UI would; an owner run after adoption that is narrower narrows Foreman's next turn, one that is wider changes nothing, and a
 * run the bridge dispatched never counts as the owner's.
 */

const later = (world: World, minutes: number) => {
  world.clock = new Date(world.clock.getTime() + minutes * 60_000);
};

/** What the latest Foreman turn ran with: its mode and the tool settings it carried. */
const lastTurn = (world: World) => {
  const options = world.startedTurns.at(-1)?.options;
  return { permissionMode: options?.permissionMode, toolsSettings: options?.toolsSettings };
};

async function adoptOwnerSession(call: Call, world: World, handOver: (sessionId: string, permissionMode?: string | null) => Promise<void>) {
  world.addOwnerSession('owner');
  world.ownerRan('owner', 'acceptEdits', { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'] });
  await handOver('owner', null);
  assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
}

async function foremanTurn(call: Call, route: 'message' | 'compact' = 'message'): Promise<void> {
  const response = await call('POST', `/sessions/owner/${route}`, route === 'message' ? { text: 'carry on' } : {});
  assert.equal(response.status, 202, JSON.stringify(response.body));
  await tick(10);
}

test('adopt stores the owner\'s mode and tools as the base, and every Foreman turn carries them exactly as the UI sends them', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    await adoptOwnerSession(call, world, handOver);
    assert.deepEqual(world.state.get('owner')?.ownerTools, {
      allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'], adoptedAt: world.clock.toISOString(),
    });
    await foremanTurn(call);
    await foremanTurn(call, 'compact');
    for (const turn of world.startedTurns) {
      assert.deepEqual(turn.options.toolsSettings, { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'], skipPermissions: false });
      assert.equal(turn.options.permissionMode, 'acceptEdits');
      assert.equal(turn.options.foremanDispatch, true);
    }
  });
});

test('the owner narrows after adoption: Foreman\'s next turn is narrower; the owner widens: Foreman stays at the base; restoring returns to it', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    await adoptOwnerSession(call, world, handOver);

    later(world, 1);
    world.ownerRan('owner', 'default', { allowedTools: ['Read', 'Grep', 'Write'], disallowedTools: ['Bash(rm:*)'] });
    await foremanTurn(call);
    assert.deepEqual(lastTurn(world), {
      permissionMode: 'default',
      toolsSettings: { allowedTools: ['Read', 'Grep'], disallowedTools: ['WebFetch', 'Bash(rm:*)'], skipPermissions: false },
    }, 'the stricter mode, the tools both allow, the tools either denies');

    later(world, 1);
    world.ownerRan('owner', 'bypassPermissions', { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep', 'WebFetch', 'Edit'], disallowedTools: [] });
    await foremanTurn(call);
    assert.deepEqual(lastTurn(world), {
      permissionMode: 'acceptEdits',
      toolsSettings: { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'], skipPermissions: false },
    }, 'never wider than the base');

    later(world, 1);
    world.ownerRan('owner', 'plan', { allowedTools: [], disallowedTools: ['Read'] });
    await foremanTurn(call, 'compact');
    assert.deepEqual(lastTurn(world), { permissionMode: 'plan', toolsSettings: { allowedTools: [], disallowedTools: ['WebFetch', 'Read'], skipPermissions: false } });

    later(world, 1);
    world.ownerRan('owner', 'acceptEdits', { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'] });
    await foremanTurn(call);
    assert.deepEqual(lastTurn(world), {
      permissionMode: 'acceptEdits',
      toolsSettings: { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep'], disallowedTools: ['WebFetch'], skipPermissions: false },
    }, 'restored: back to the base');
  });
});

test('a run the bridge dispatched never changes what counts as the owner\'s: neither before adoption nor after', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    await adoptOwnerSession(call, world, handOver);
    later(world, 1);
    world.ownerRan('owner', 'default', { allowedTools: ['Read'], disallowedTools: [] });
    later(world, 1);
    // Foreman's own turn, as the runtime reports it: marked, and with whatever it carried. It is not the owner's.
    world.runModes.observe(runStarted('owner', 'bypassPermissions', { allowedTools: ['Read', 'Bash(npm test:*)', 'Grep', 'Edit'], foremanDispatch: true }));
    assert.equal(world.runModeRows.get('owner')?.permission_mode, 'default');
    await foremanTurn(call);
    assert.deepEqual(lastTurn(world), { permissionMode: 'default', toolsSettings: { allowedTools: ['Read'], disallowedTools: ['WebFetch'], skipPermissions: false } });

    // Released and handed over again: the new base is the owner's own last run, not Foreman's.
    assert.equal((await call('POST', '/sessions/owner/release', {})).status, 200);
    await handOver('owner', null);
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
    assert.deepEqual(world.state.get('owner')?.permissionMode, 'default');
    assert.deepEqual(world.state.get('owner')?.ownerTools?.allowedTools, ['Read']);
  });
});

test('every turn the bridge dispatches is marked as the bridge\'s, for a session it started and one handed over', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    const started = await call('POST', '/sessions', startBody());
    const sessionId = started.body.data.sessionId as string;
    await tick(10);
    assert.equal((await call('POST', `/sessions/${sessionId}/message`, { text: 'go on' })).status, 202);
    await tick(10);
    await adoptOwnerSession(call, world, handOver);
    await foremanTurn(call);
    assert.deepEqual(world.startedTurns.map((turn) => turn.options.foremanDispatch), [true, true, true]);
    assert.equal('toolsSettings' in world.startedTurns[0].options, false, 'a worker runs with its sandbox\'s tools, not an owner\'s');
  });
});

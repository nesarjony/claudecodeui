import assert from 'node:assert/strict';
import test from 'node:test';

import { HANDOVER_GRANT_TTL_MS } from '@/modules/foreman/foreman-handover.service.js';

import { row, TOKEN, withBridge, type World } from './foreman-routes-support.js';

/**
 * The owner's grant: Foreman adopts a session only after its logged-in owner granted it in cloudcli (`POST /api/foreman-suggestions/handover/:id`,
 * behind the login), and each grant is used once and expires after five minutes. The bridge token alone never hands a session over.
 */

const T0 = new Date('2026-11-14T09:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const addOwner = (world: World, sessionId = 'owner') => world.addOwnerSession(sessionId, { model: 'claude-opus-5-5' });

test('the logged-in owner grants a hand-over: 201 with its expiry, recorded under their name, and a second grant replaces the first', async () => {
  await withBridge(async ({ ui, world }) => {
    addOwner(world);
    world.clock = T0;
    const granted = await ui('POST', '/handover/owner');
    assert.equal(granted.status, 201);
    assert.deepEqual(granted.body, { success: true, data: { sessionId: 'owner', expiresAt: at(HANDOVER_GRANT_TTL_MS).toISOString() } });
    assert.equal(HANDOVER_GRANT_TTL_MS, 5 * 60_000);
    assert.deepEqual(world.grantRows.get('owner'), { session_id: 'owner', granted_by: 'nesar', created_at: T0.toISOString(), expires_at: '2026-11-14T09:05:00.000Z' });

    world.clock = at(2 * 60_000);
    world.loggedIn = { id: 7 };
    assert.equal((await ui('POST', '/handover/owner')).body.data.expiresAt, '2026-11-14T09:07:00.000Z');
    assert.deepEqual([...world.grantRows.values()], [{ session_id: 'owner', granted_by: '7', created_at: '2026-11-14T09:02:00.000Z', expires_at: '2026-11-14T09:07:00.000Z' }], 'one grant per session; a user without a name is recorded by id');
  });
});

test('adopt without a grant is 403 HANDOVER_NOT_GRANTED and changes nothing; the same key works once the owner grants', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world);
    world.ownerRan('owner', 'default');
    const refused = await call('POST', '/sessions/owner/adopt', { taskId: 'task-9', idempotencyKey: 'adopt:owner:1' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'HANDOVER_NOT_GRANTED');
    assert.equal(world.state.get('owner'), null, 'not supervised');
    assert.deepEqual(world.headCalls, [], 'no head lookup');
    assert.equal(world.events.last('owner'), null, 'no events');
    assert.equal(world.idempotencyStorage.rows.size, 0, 'the key stays free');
    assert.equal((await call('GET', '/sessions')).body.data.sessions.find((entry: { id: string }) => entry.id === 'owner').taskId, null);
    assert.deepEqual(world.startedTurns, []);

    await handOver('owner');
    const adopted = await call('POST', '/sessions/owner/adopt', { taskId: 'task-9', idempotencyKey: 'adopt:owner:1' });
    assert.equal(adopted.status, 200);
    assert.equal(world.state.get('owner')?.supervision, 'adopted');
    assert.equal(world.grantRows.size, 0, 'the adopt used the grant up');
  });
});

test('a grant is used once: after a release the session needs a new grant, and a repeat of the answered adopt changes nothing', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world);
    await handOver('owner');
    const first = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' });
    assert.equal(first.status, 200);
    assert.equal((await call('POST', '/sessions/owner/release', {})).status, 200);

    const again = await call('POST', '/sessions/owner/adopt', {});
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'HANDOVER_NOT_GRANTED');
    // The answered call repeated gets its stored answer and adopts nothing: the session stays released.
    assert.deepEqual((await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' })).body, first.body);
    assert.equal(world.state.get('owner')?.supervision, 'released');

    await handOver('owner');
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
  });
});

test('a grant expires five minutes after it was given, and an expired one is dropped by the next grant', async () => {
  await withBridge(async ({ call, ui, world, handOver }) => {
    addOwner(world, 'early');
    addOwner(world, 'late');
    world.clock = T0;
    await handOver('early');
    await handOver('late');

    world.clock = at(HANDOVER_GRANT_TTL_MS - 1);
    assert.equal((await call('POST', '/sessions/early/adopt', {})).status, 200, 'still valid a moment before it expires');
    world.clock = at(HANDOVER_GRANT_TTL_MS);
    const expired = await call('POST', '/sessions/late/adopt', {});
    assert.equal(expired.status, 403);
    assert.equal(expired.body.error.code, 'HANDOVER_NOT_GRANTED');
    assert.equal(world.state.get('late'), null);
    assert.equal(world.grantRows.has('late'), true, 'an expired grant is kept until something purges it');

    addOwner(world, 'other');
    assert.equal((await ui('POST', '/handover/other')).status, 201);
    assert.deepEqual([...world.grantRows.keys()], ['other'], 'the next grant purged the expired one');
  });
});

test('the owner can revoke a grant Foreman has not used, and revoking again is harmless', async () => {
  await withBridge(async ({ call, ui, world, handOver }) => {
    addOwner(world);
    await handOver('owner');
    assert.deepEqual((await ui('DELETE', '/handover/owner')).body, { success: true, data: { sessionId: 'owner', revoked: true } });
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).body.error.code, 'HANDOVER_NOT_GRANTED');
    assert.deepEqual((await ui('DELETE', '/handover/owner')).body.data, { sessionId: 'owner', revoked: false });
    assert.equal((await ui('DELETE', `/handover/${encodeURIComponent('bad id')}`)).status, 400);
    assert.equal(world.state.get('owner'), null);
  });
});

test('a grant needs a Claude session Foreman does not supervise yet; any other is refused and nothing is stored', async () => {
  await withBridge(async ({ call, ui, world, handOver }) => {
    addOwner(world);
    world.rows.set('worker', row({ session_id: 'worker' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    await handOver('owner');
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);

    const refusals: Array<[string, number, string]> = [
      ['owner', 409, 'ALREADY_SUPERVISED'],
      ['worker', 409, 'ALREADY_SUPERVISED'],
      ['nope', 404, 'SESSION_NOT_FOUND'],
      ['codex', 400, 'UNSUPPORTED_PROVIDER'],
      [encodeURIComponent('bad id'), 400, 'INVALID_SESSION_ID'],
    ];
    for (const [sessionId, status, code] of refusals) {
      const response = await ui('POST', `/handover/${sessionId}`);
      assert.deepEqual([response.status, response.body.error.code], [status, code], sessionId);
    }
    assert.equal(world.grantRows.size, 0);
  });
});

test('nobody logged in cannot grant or revoke: 401 AUTH_REQUIRED, and nothing changes', async () => {
  await withBridge(async ({ ui, world, handOver }) => {
    addOwner(world);
    addOwner(world, 'granted');
    await handOver('granted');
    for (const loggedIn of [null, {}, { username: '' }]) {
      world.loggedIn = loggedIn;
      for (const [method, pathname] of [['POST', '/handover/owner'], ['DELETE', '/handover/granted']] as const) {
        const response = await ui(method, pathname);
        assert.deepEqual([response.status, response.body.error.code], [401, 'AUTH_REQUIRED'], `${method} as ${JSON.stringify(loggedIn)}`);
      }
    }
    assert.deepEqual([...world.grantRows.keys()], ['granted']);
  });
});

test('the bridge token cannot hand a session over: the bridge has no grant route, and the grant route does not take the token', async () => {
  await withBridge(async ({ baseUrl, call, world }) => {
    addOwner(world);
    world.ownerRan('owner', 'default');
    for (const pathname of ['/sessions/owner/handover', '/sessions/owner/grant', '/handover/owner', '/sessions/owner/adopt/grant']) {
      for (const method of ['POST', 'PUT']) {
        const response = await fetch(`${baseUrl}/api/foreman${pathname}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ idempotencyKey: 'try:1', grantedBy: 'nesar' }),
        });
        assert.equal(response.status, 404, `${method} ${pathname}`);
      }
    }
    world.loggedIn = null;
    const withToken = await fetch(`${baseUrl}/api/foreman-suggestions/handover/owner`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(withToken.status, 401);
    assert.equal(world.grantRows.size, 0);
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 403);
  });
});

test('two adopts racing for one grant: one adopts, the other is refused', async () => {
  await withBridge(async ({ call, world, handOver }) => {
    addOwner(world);
    await handOver('owner');
    const answers = await Promise.all([call('POST', '/sessions/owner/adopt', {}), call('POST', '/sessions/owner/adopt', {})]);
    const statuses = answers.map((answer) => answer.status).sort();
    assert.equal(statuses[0], 200);
    assert.ok(statuses[1] === 403 || statuses[1] === 409, `the second is refused: ${statuses[1]}`);
    assert.deepEqual(world.headCalls, ['/mnt/dev/known'], 'adopted once');
  });
});

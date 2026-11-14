import assert from 'node:assert/strict';
import test from 'node:test';

import type { ForemanBridgeEventBody } from '@/shared/types.js';

import { HEAD, row, startBody, tick, withBridge, type World } from './foreman-routes-support.js';

/**
 * The session state and event reads, and the hand-over: the owner gives one of their own sessions to Foreman (`adopt`) and takes it
 * back (`release`). Foreman drives only the sessions it started or was handed.
 */

const NO_USAGE = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
const turnEnd = (text = 'Done.'): ForemanBridgeEventBody => ({ kind: 'turn_end', payload: { text, commitCount: 0, headSha: null, claimsDone: false, model: null, usage: NO_USAGE } });
const sessionEnd = (reason: 'stopped' | 'crashed' = 'stopped'): ForemanBridgeEventBody => ({ kind: 'session_end', payload: { reason } });

/** The session's own model, effort and name: what a hand-over must leave exactly as it is. */
const OWNER = { model: 'claude-opus-5-5', effort: 'high', custom_name: 'My own work' } as const;
const addOwner = (world: World, sessionId = 'owner') => world.addOwnerSession(sessionId, OWNER);

// ---------------------------------------------------------------------------------------------
// GET /sessions/:id/state
// ---------------------------------------------------------------------------------------------

test('GET /sessions/:id/state reports idle, running, ended, the stored event count and who supervises the session', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    const idle = await call('GET', '/sessions/s1/state');
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body.data, { sessionId: 's1', status: 'idle', lastSequence: 0, supervision: 'started' });

    world.processing.add('s1');
    assert.equal((await call('GET', '/sessions/s1/state')).body.data.status, 'running');
    world.processing.clear();
    // A session that waits for a permission answer is still running as far as Foreman is concerned.
    world.approvals.set('s1', [{ requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() }]);
    assert.equal((await call('GET', '/sessions/s1/state')).body.data.status, 'running');
    world.approvals.clear();

    world.events.append('s1', turnEnd());
    const afterTurn = (await call('GET', '/sessions/s1/state')).body.data;
    assert.deepEqual([afterTurn.status, afterTurn.lastSequence], ['idle', 1], 'a turn that ended is not the end of the session');

    world.events.append('s1', sessionEnd());
    const ended = (await call('GET', '/sessions/s1/state')).body.data;
    assert.deepEqual([ended.status, ended.lastSequence], ['ended', 2]);

    // Ended only while nothing runs: a message after the stop starts a run again, and the next event is no session_end.
    world.processing.add('s1');
    assert.equal((await call('GET', '/sessions/s1/state')).body.data.status, 'running');
    world.processing.clear();
    world.events.append('s1', turnEnd('Back at work.'));
    assert.deepEqual(((await call('GET', '/sessions/s1/state')).body.data), { sessionId: 's1', status: 'idle', lastSequence: 3, supervision: 'started' });
  });
});

test('the state counts only the events that are stored: a session that ran turns has none until its events are stored', async () => {
  await withBridge(async ({ call, world }) => {
    const started = await call('POST', '/sessions', startBody());
    const sessionId = started.body.data.sessionId as string;
    assert.equal(world.startedTurns.length, 1, 'a turn was started');
    assert.equal((await call('GET', `/sessions/${sessionId}/state`)).body.data.lastSequence, 0);

    world.events.append(sessionId, turnEnd());
    world.events.append('another-session', turnEnd());
    world.events.append('another-session', turnEnd());
    assert.equal((await call('GET', `/sessions/${sessionId}/state`)).body.data.lastSequence, 1, 'another session\'s events are not counted');
  });
});

test('the state of a session that failed is idle, and of one that Foreman never supervised has no supervision', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('broken', row({ session_id: 'broken' }));
    world.state.setStatus('broken', 'error');
    world.addOwnerSession('owner');
    assert.deepEqual((await call('GET', '/sessions/broken/state')).body.data, { sessionId: 'broken', status: 'idle', lastSequence: 0, supervision: 'started' });
    assert.deepEqual((await call('GET', '/sessions/owner/state')).body.data, { sessionId: 'owner', status: 'idle', lastSequence: 0, supervision: null });
  });
});

test('GET /sessions/:id/state validates the session', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    const missing = await call('GET', '/sessions/nope/state');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await call('GET', '/sessions/codex/state')).status, 400);
    assert.equal((await call('GET', `/sessions/${encodeURIComponent('bad id')}/state`)).status, 400);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /sessions/:id/events
// ---------------------------------------------------------------------------------------------

const addEvents = (world: World, sessionId: string, count: number) => {
  for (let index = 1; index <= count; index += 1) world.events.append(sessionId, turnEnd(`turn ${index}`));
};
const sequences = (response: { body: any }) => (response.body.data.events as Array<{ sequence: number }>).map((event) => event.sequence);

test('GET /sessions/:id/events returns what is above `after`, oldest first, and says when a limit cut the page', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('s2', row({ session_id: 's2' }));
    addEvents(world, 's1', 5);
    addEvents(world, 's2', 2);

    const all = await call('GET', '/sessions/s1/events');
    assert.equal(all.status, 200);
    assert.equal(all.body.data.sessionId, 's1');
    assert.deepEqual(sequences(all), [1, 2, 3, 4, 5]);
    assert.equal(all.body.data.hasMore, false);
    assert.deepEqual(all.body.data.events[2], { id: 's1:3', sessionId: 's1', sequence: 3, kind: 'turn_end', payload: { text: 'turn 3', commitCount: 0, headSha: null, claimsDone: false, model: null, usage: NO_USAGE } });

    assert.deepEqual(sequences(await call('GET', '/sessions/s1/events?after=2')), [3, 4, 5]);
    assert.deepEqual(sequences(await call('GET', '/sessions/s1/events?after=0')), [1, 2, 3, 4, 5]);
    const past = await call('GET', '/sessions/s1/events?after=5');
    assert.deepEqual([sequences(past), past.body.data.hasMore], [[], false]);

    const firstPage = await call('GET', '/sessions/s1/events?limit=2');
    assert.deepEqual([sequences(firstPage), firstPage.body.data.hasMore], [[1, 2], true]);
    const middle = await call('GET', '/sessions/s1/events?after=1&limit=3');
    assert.deepEqual([sequences(middle), middle.body.data.hasMore], [[2, 3, 4], true]);
    // A page that ends exactly with the last event has nothing more behind it.
    const exact = await call('GET', '/sessions/s1/events?after=2&limit=3');
    assert.deepEqual([sequences(exact), exact.body.data.hasMore], [[3, 4, 5], false]);
    assert.deepEqual(sequences(await call('GET', '/sessions/s2/events')), [1, 2], 'another session\'s events are not mixed in');
  });
});

test('asking again from the last sequence while hasMore is true reads the whole log in order', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    addEvents(world, 's1', 7);
    const seen: number[] = [];
    let after = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await call('GET', `/sessions/s1/events?after=${after}&limit=3`);
      seen.push(...sequences(response));
      if (!response.body.data.hasMore) break;
      after = seen.at(-1) ?? after;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  });
});

test('GET /sessions/:id/events validates `after` and `limit` and the session', async () => {
  await withBridge(async ({ call, world }) => {
    world.addOwnerSession('owner');
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    for (const query of ['after=-1', 'after=abc', 'after=1.5', 'after=', 'after=1&after=2', 'after=2000000001', 'after=3000000000', 'after=99999999999', 'limit=0', 'limit=501', 'limit=abc', 'limit=-5', 'limit=']) {
      const response = await call('GET', `/sessions/owner/events?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.success, false, query);
    }
    assert.equal((await call('GET', '/sessions/owner/events?limit=500')).status, 200);
    // The advertised maximum of `after` is ten digits long.
    assert.deepEqual((await call('GET', '/sessions/owner/events?after=2000000000')).body.data, { sessionId: 'owner', events: [], hasMore: false });
    // Events of a session the owner never handed over are simply none.
    assert.deepEqual((await call('GET', '/sessions/owner/events')).body.data, { sessionId: 'owner', events: [], hasMore: false });

    const missing = await call('GET', '/sessions/nope/events');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await call('GET', '/sessions/codex/events')).status, 400);
    assert.equal((await call('GET', `/sessions/${encodeURIComponent('bad id')}/events`)).status, 400);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/adopt
// ---------------------------------------------------------------------------------------------

test('adopt takes over a session of the owner as it is: model, billing and settings are untouched, no sandbox, the start is recorded', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    assert.equal(world.state.get('owner'), null);

    const response = await call('POST', '/sessions/owner/adopt', { taskId: 'task-3' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, {
      sessionId: 'owner',
      status: 'idle',
      lastSequence: 0,
      supervision: 'adopted',
      projectPath: '/mnt/dev/known',
      model: 'claude-opus-5-5',
      billing: 'subscription',
    });

    // The session is what it was: its row, its routing and its marks.
    assert.deepEqual({ model: world.rows.get('owner')?.model, effort: world.rows.get('owner')?.effort, name: world.rows.get('owner')?.custom_name }, { model: 'claude-opus-5-5', effort: 'high', name: 'My own work' });
    assert.deepEqual(world.modelChanges, []);
    assert.deepEqual(world.liveModelChanges, []);
    assert.deepEqual(world.managedMarks, [], 'not marked as a worker: it keeps its owner\'s autocompact threshold');
    assert.deepEqual(world.startedTurns, [], 'adopting runs nothing');
    assert.deepEqual(world.created, []);
    assert.deepEqual(world.announced, []);
    assert.equal(world.state.sandboxOf('owner'), null, 'no sandbox is added');

    const state = world.state.get('owner');
    assert.equal(state?.supervision, 'adopted');
    assert.equal(state?.sandboxJson, null);
    assert.equal(state?.permissionMode, null, 'the owner\'s permission mode is not replaced');
    assert.equal(state?.billing, 'subscription');
    assert.equal(state?.taskId, 'task-3');
    assert.equal(state?.baseHead, HEAD);
    assert.equal(state?.baseSequence, 0);
    assert.deepEqual(world.headCalls, ['/mnt/dev/known']);

    const listed = (await call('GET', '/sessions')).body.data.sessions.find((entry: { id: string }) => entry.id === 'owner');
    assert.deepEqual([listed.supervision, listed.sandboxed, listed.taskId, listed.model], ['adopted', false, 'task-3', 'claude-opus-5-5']);
  });
});

test('adopting a session that has a cap model keeps its billing, and one that is mid-run is reported as running', async () => {
  await withBridge(async ({ call, world }) => {
    world.addOwnerSession('capped', { model: 'claude-sonnet-5-5@cap' });
    world.processing.add('capped');
    const response = await call('POST', '/sessions/capped/adopt', {});
    assert.equal(response.status, 200);
    assert.deepEqual([response.body.data.status, response.body.data.billing, response.body.data.model], ['running', 'cap', 'claude-sonnet-5-5']);
    assert.equal(world.rows.get('capped')?.model, 'claude-sonnet-5-5@cap');
    assert.equal(world.state.get('capped')?.baseHead, HEAD);
  });
});

test('adopting a project that has no commit still adopts the session', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    world.head = null;
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
    assert.equal(world.state.get('owner')?.baseHead, null);
  });
});

test('adopting twice is a 409 ALREADY_SUPERVISED, unless it is the same call repeated, which gets the same answer', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    const first = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' });
    assert.equal(first.status, 200);

    const second = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:2' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ALREADY_SUPERVISED');

    const repeat = await call('POST', '/sessions/owner/adopt', { idempotencyKey: 'adopt:owner:1' });
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body, first.body);
    assert.deepEqual(world.headCalls, ['/mnt/dev/known'], 'the repeat adopted nothing again');

    // A session Foreman started is supervised from the start.
    world.rows.set('worker', row({ session_id: 'worker' }));
    assert.equal((await call('POST', '/sessions/worker/adopt', {})).body.error.code, 'ALREADY_SUPERVISED');
  });
});

test('adopt validates the session and the task id, and a refused adopt changes nothing', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    const unknown = await call('POST', '/sessions/nope/adopt', {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await call('POST', '/sessions/codex/adopt', {})).status, 400);
    assert.equal((await call('POST', `/sessions/${encodeURIComponent('bad id')}/adopt`, {})).status, 400);
    assert.equal((await call('POST', '/sessions/owner/adopt', { taskId: 'has space' })).status, 400);
    assert.equal(world.state.get('owner'), null);
    assert.deepEqual(world.headCalls, []);
    assert.equal(world.idempotencyStorage.rows.size, 0, 'no refused call burned its key');
  });
});

// ---------------------------------------------------------------------------------------------
// A session that is not Foreman's is not driven
// ---------------------------------------------------------------------------------------------

test('before the hand-over every call that drives an owner session is a 409 NOT_SUPERVISED and does nothing, and the same calls work after it', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    world.live.add('owner');
    world.processing.add('owner');
    world.approvals.set('owner', [{ requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() }]);

    const calls: Array<[string, string, Record<string, unknown>]> = [
      // Mid-run and without `interrupt` a supervised session answers RUN_IN_PROGRESS; an owner session must not even say that.
      ['message mid-run', '/sessions/owner/message', { text: 'hello', idempotencyKey: 'drive:message-mid-run' }],
      ['message with interrupt', '/sessions/owner/message', { text: 'hello', interrupt: true, idempotencyKey: 'drive:message' }],
      ['interrupt', '/sessions/owner/interrupt', { idempotencyKey: 'drive:interrupt' }],
      ['permission', '/sessions/owner/permission', { requestId: 'req-1', decision: 'allow', idempotencyKey: 'drive:permission' }],
      ['model', '/sessions/owner/model', { model: 'sonnet', idempotencyKey: 'drive:model' }],
      ['compact', '/sessions/owner/compact', { idempotencyKey: 'drive:compact' }],
    ];
    for (const [label, pathname, body] of calls) {
      const response = await call('POST', pathname, body);
      assert.equal(response.status, 409, label);
      assert.equal(response.body.error.code, 'NOT_SUPERVISED', label);
    }
    assert.deepEqual(world.startedTurns, []);
    assert.deepEqual(world.aborted, []);
    assert.deepEqual(world.completedRuns, []);
    assert.deepEqual(world.resolvedPermissions, []);
    assert.deepEqual(world.modelChanges, []);
    assert.deepEqual(world.liveModelChanges, []);
    assert.equal(world.approvals.get('owner')?.length, 1, 'the prompt is still waiting for its owner');
    assert.equal(world.idempotencyStorage.rows.size, 0, 'a refused call leaves its key free');

    // Reading is not driving: the owner's session can be looked at.
    assert.equal((await call('GET', '/sessions/owner/permissions')).status, 200);
    assert.equal((await call('GET', '/sessions/owner/state')).status, 200);

    // Once the owner hands it over the very same calls go through.
    assert.equal((await call('POST', '/sessions/owner/adopt', {})).status, 200);
    world.processing.clear();
    const bodyOf = (label: string) => calls.find(([name]) => name === label)?.[2] ?? {};
    assert.equal((await call('POST', '/sessions/owner/message', bodyOf('message with interrupt'))).status, 202);
    assert.equal((await call('POST', '/sessions/owner/permission', bodyOf('permission'))).status, 200);
    assert.equal((await call('POST', '/sessions/owner/interrupt', bodyOf('interrupt'))).status, 200);
  });
});

test('an owner session that is not Foreman\'s answers NOT_SUPERVISED before anything else, so no state of it leaks: not a running turn, not a missing API key', async () => {
  await withBridge(async ({ call, world }) => {
    world.addOwnerSession('billed-to-key', { model: 'claude-opus-5-5@api' });
    world.apiKeyAvailable = false;
    world.processing.add('billed-to-key');
    for (const [pathname, body] of [
      ['/sessions/billed-to-key/message', { text: 'hello' }],
      ['/sessions/billed-to-key/compact', {}],
    ] as const) {
      const response = await call('POST', pathname, body);
      assert.equal(response.status, 409, pathname);
      assert.equal(response.body.error.code, 'NOT_SUPERVISED', pathname);
    }
    world.processing.clear();
    const idle = await call('POST', '/sessions/billed-to-key/message', { text: 'hello' });
    assert.equal(idle.body.error.code, 'NOT_SUPERVISED', 'idle and with no API key it is still not Foreman\'s to drive');
    assert.deepEqual(world.startedTurns, []);
  });
});

// ---------------------------------------------------------------------------------------------
// What works on an adopted session, and what is locked
// ---------------------------------------------------------------------------------------------

test('on an adopted session a message runs with the session\'s own model and settings and no permission mode of Foreman\'s', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});

    const response = await call('POST', '/sessions/owner/message', { text: 'Carry on with the migration' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body.data, { sessionId: 'owner', accepted: true, interrupted: false });
    const turn = world.startedTurns[0];
    assert.equal(turn.sessionId, 'owner');
    assert.equal(turn.content, 'Carry on with the migration');
    assert.equal(turn.options.model, 'claude-opus-5-5');
    assert.equal(turn.options.effort, 'high');
    assert.equal(turn.options.permissionMode, undefined, 'the owner\'s own permission mode applies');
    assert.equal(world.state.get('owner')?.permissionMode, null);
    assert.equal(world.rows.get('owner')?.model, 'claude-opus-5-5');

    // Steering a run that is going works as for any supervised session.
    await tick();
    world.processing.add('owner');
    assert.equal((await call('POST', '/sessions/owner/message', { text: 'wait, stop', interrupt: true })).body.data.interrupted, true);
    assert.equal(world.startedTurns[1].interruptActiveRun, true);
  });
});

test('on an adopted session a permission mode is refused with PERMISSION_MODE_LOCKED, for a message and for a compact', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});

    for (const permissionMode of ['bypassPermissions', 'acceptEdits', 'default']) {
      const message = await call('POST', '/sessions/owner/message', { text: 'go', permissionMode });
      assert.equal(message.status, 400, permissionMode);
      assert.equal(message.body.error.code, 'PERMISSION_MODE_LOCKED');
      const compact = await call('POST', '/sessions/owner/compact', { permissionMode });
      assert.equal(compact.status, 400, permissionMode);
      assert.equal(compact.body.error.code, 'PERMISSION_MODE_LOCKED');
    }
    assert.equal(world.startedTurns.length, 0, 'nothing ran');
    assert.equal(world.state.get('owner')?.permissionMode, null);
    assert.equal(world.idempotencyStorage.rows.size, 1, 'only the adopt call holds a key');

    // Without a mode, a compact goes through as a /compact turn in the owner's own mode.
    const plain = await call('POST', '/sessions/owner/compact', { instructions: 'Keep the schema.' });
    assert.equal(plain.status, 202);
    assert.equal(world.startedTurns[0].content, '/compact Keep the schema.');
    assert.equal(world.startedTurns[0].options.permissionMode, undefined);
  });
});

test('on an adopted session a model change is refused with MODEL_LOCKED, live or idle, and the model stays the owner\'s', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});
    for (const live of [false, true]) {
      if (live) world.live.add('owner');
      const response = await call('POST', '/sessions/owner/model', { model: 'claude-haiku-4-5' });
      assert.equal(response.status, 409, `live: ${live}`);
      assert.equal(response.body.error.code, 'MODEL_LOCKED');
    }
    assert.deepEqual(world.modelChanges, []);
    assert.deepEqual(world.liveModelChanges, [], 'the running process is not switched either');
    assert.equal(world.rows.get('owner')?.model, 'claude-opus-5-5');

    // A session Foreman started is a different matter: its model can be changed.
    world.rows.set('worker', row({ session_id: 'worker', model: 'sonnet@cap' }));
    assert.equal((await call('POST', '/sessions/worker/model', { model: 'opus' })).status, 200);
  });
});

test('on an adopted session a permission answer and an interrupt work', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});
    world.processing.add('owner');
    world.live.add('owner');
    world.approvals.set('owner', [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, receivedAt: new Date() }]);

    const listed = await call('GET', '/sessions/owner/permissions');
    assert.deepEqual(listed.body.data.permissions.map((entry: { requestId: string }) => entry.requestId), ['req-1']);
    const answered = await call('POST', '/sessions/owner/permission', { requestId: 'req-1', decision: 'deny', reason: 'Not now.' });
    assert.equal(answered.status, 200);
    assert.deepEqual(world.resolvedPermissions, [{ requestId: 'req-1', decision: { allow: false, message: 'Not now.' } }]);

    const stopped = await call('POST', '/sessions/owner/interrupt', {});
    assert.equal(stopped.status, 200);
    assert.deepEqual(world.aborted, ['owner']);
    assert.deepEqual(world.completedRuns, [{ sessionId: 'owner', exitCode: 0, aborted: true }]);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/release
// ---------------------------------------------------------------------------------------------

test('release is only for an adopted session: a started one or one that was never supervised is 409 NOT_ADOPTED', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('worker', row({ session_id: 'worker' }));
    world.addOwnerSession('owner');
    for (const sessionId of ['worker', 'owner']) {
      const response = await call('POST', `/sessions/${sessionId}/release`, {});
      assert.equal(response.status, 409, sessionId);
      assert.equal(response.body.error.code, 'NOT_ADOPTED', sessionId);
    }
    assert.equal((await call('POST', '/sessions/nope/release', {})).status, 404);
    assert.equal(world.state.get('worker')?.supervision, 'started');
    assert.equal(world.state.get('owner'), null);
    assert.equal(world.settleCalls, 0, 'a refused release waits for nothing');
  });
});

test('release waits until the stored events have settled before it lets go, then the session is the owner\'s again', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', { taskId: 'task-3' });
    const during: Array<string | undefined> = [];
    world.onSettle = async () => {
      during.push(world.state.get('owner')?.supervision);
      await tick(40);
      during.push(world.state.get('owner')?.supervision);
    };

    const response = await call('POST', '/sessions/owner/release', {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionId: 'owner', status: 'idle', lastSequence: 0, supervision: 'released' });
    assert.equal(world.settleCalls, 1);
    assert.deepEqual(during, ['adopted', 'adopted'], 'still supervised the whole time the events were settling, so none of them is dropped');
    assert.equal(world.state.get('owner')?.supervision, 'released');
    assert.equal((await call('GET', '/sessions/owner/state')).body.data.supervision, 'released');

    // What was the owner's stays the owner's.
    assert.equal(world.rows.get('owner')?.model, 'claude-opus-5-5');
    assert.deepEqual(world.modelChanges, []);
    assert.equal(world.state.get('owner')?.permissionMode, null);
    assert.equal((await call('GET', '/sessions')).body.data.sessions.find((entry: { id: string }) => entry.id === 'owner').supervision, 'released');
  });
});

test('after release Foreman can no longer drive the session', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    world.live.add('owner');
    await call('POST', '/sessions/owner/adopt', {});
    assert.equal((await call('POST', '/sessions/owner/release', {})).status, 200);
    world.processing.add('owner');
    world.approvals.set('owner', [{ requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() }]);

    const refused: Array<[string, Record<string, unknown>]> = [
      ['message', { text: 'hello', interrupt: true }],
      ['interrupt', {}],
      ['permission', { requestId: 'req-1', decision: 'allow' }],
      ['model', { model: 'sonnet' }],
      ['compact', {}],
    ];
    for (const [route, body] of refused) {
      if (route === 'compact') world.processing.delete('owner');
      const response = await call('POST', `/sessions/owner/${route}`, body);
      assert.equal(response.status, 409, route);
      assert.equal(response.body.error.code, 'NOT_SUPERVISED', route);
    }
    assert.deepEqual(world.startedTurns, []);
    assert.deepEqual(world.aborted, []);
    assert.deepEqual(world.resolvedPermissions, []);
    assert.deepEqual(world.modelChanges, []);

    // Releasing again is not a second hand-over to give back.
    const again = await call('POST', '/sessions/owner/release', {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'NOT_ADOPTED');
  });
});

test('a repeated release call answers as the first did and waits for the events only once', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});
    const first = await call('POST', '/sessions/owner/release', { idempotencyKey: 'release:owner:1' });
    const repeat = await call('POST', '/sessions/owner/release', { idempotencyKey: 'release:owner:1' });
    assert.equal(first.status, 200);
    assert.deepEqual(repeat.body, first.body);
    assert.equal(world.settleCalls, 1);
  });
});

test('a released session can be adopted again, and counts from where it stands then', async () => {
  await withBridge(async ({ call, world }) => {
    addOwner(world);
    await call('POST', '/sessions/owner/adopt', {});
    assert.equal(world.state.get('owner')?.baseSequence, 0);

    // Three events are stored while Foreman supervises, then the owner takes the session back and works on it alone.
    addEvents(world, 'owner', 3);
    assert.equal((await call('POST', '/sessions/owner/release', {})).body.data.lastSequence, 3);
    world.head = 'b'.repeat(40);

    const again = await call('POST', '/sessions/owner/adopt', {});
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.data.supervision, again.body.data.lastSequence], ['adopted', 3]);
    const state = world.state.get('owner');
    assert.equal(state?.supervision, 'adopted');
    assert.equal(state?.baseSequence, 3, 'only events after this point belong to the new hand-over');
    assert.equal(state?.baseHead, 'b'.repeat(40), 'and only commits after the project\'s head of now');
    assert.equal(state?.sandboxJson, null);

    // Driving works again, with the owner's own model.
    assert.equal((await call('POST', '/sessions/owner/message', { text: 'one more thing' })).status, 202);
    assert.equal(world.startedTurns[0].options.model, 'claude-opus-5-5');
    assert.equal(world.rows.get('owner')?.model, 'claude-opus-5-5');
    assert.deepEqual(world.modelChanges, []);
  });
});

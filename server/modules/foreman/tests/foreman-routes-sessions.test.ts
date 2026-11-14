import assert from 'node:assert/strict';
import test from 'node:test';

import { HEAD, row, startBody, tick, TOKEN, withBridge, type World } from './foreman-routes-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';

/** Where a session started in the known project works, as its sandbox is stored with it: the world reports no git directory. */
const KNOWN_SCOPE = { projectPath: '/mnt/dev/known', gitCommonDir: null };

// ---------------------------------------------------------------------------------------------
// POST /sessions
// ---------------------------------------------------------------------------------------------

test('POST /sessions starts a session through the UI path and returns its id at once', async () => {
  await withBridge(async ({ call, world }) => {
    const response = await call('POST', '/sessions', startBody({
      prompt: 'Implement the login form and run the tests',
      model: 'claude-sonnet-5-5',
      billing: 'api-key',
      permissionMode: 'acceptEdits',
      title: 'Login form',
      taskId: 'task-42',
      effort: 'high',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.sessionId, 'new-1');
    assert.deepEqual(
      { projectPath: data.projectPath, title: data.title, model: data.model, billing: data.billing, permissionMode: data.permissionMode, taskId: data.taskId, status: data.status, sandboxed: data.sandboxed },
      { projectPath: '/mnt/dev/known', title: 'Login form', model: 'claude-sonnet-5-5', billing: 'api-key', permissionMode: 'acceptEdits', taskId: 'task-42', status: 'running', sandboxed: true },
    );

    // The same calls the UI makes: allocate the session, then send the first turn with its options.
    assert.deepEqual(world.created, [{ projectPath: '/mnt/dev/known', initialMessage: 'Login form' }]);
    assert.equal(world.startedTurns.length, 1);
    assert.equal(world.startedTurns[0].sessionId, 'new-1');
    assert.equal(world.startedTurns[0].content, 'Implement the login form and run the tests');
    assert.equal(world.startedTurns[0].options.model, 'claude-sonnet-5-5@api');
    assert.equal(world.startedTurns[0].options.permissionMode, 'acceptEdits');
    assert.equal(world.startedTurns[0].options.effort, 'high');
    assert.equal(world.startedTurns[0].interruptActiveRun, undefined);
    assert.deepEqual(world.announced, ['new-1']);
    assert.equal(world.rows.get('new-1')?.custom_name, 'Login form');

    // The task link is remembered for later events and shows in listings.
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((s: { id: string }) => s.id === 'new-1').taskId, 'task-42');
  });
});

test('POST /sessions marks the new session as started through the bridge (it gets the worker autocompact threshold)', async () => {
  await withBridge(async ({ call, world }) => {
    const response = await call('POST', '/sessions', startBody({ prompt: 'Do the thing' }));
    assert.equal(response.status, 201);
    assert.deepEqual(world.managedMarks, [response.body.data.sessionId]);
    // A rejected start (unknown project) marks nothing and leaves nothing in the state.
    await call('POST', '/sessions', startBody({ projectPath: '/mnt/dev/nowhere', prompt: 'x' }));
    assert.equal(world.managedMarks.length, 1);
    assert.deepEqual([...world.stateRows.keys()], [response.body.data.sessionId]);
  });
});

test('POST /sessions defaults: cap billing (no billing and no marked model), default model and permission mode', async () => {
  await withBridge(async ({ call, world }) => {
    const { permissionMode: _permissionMode, ...withoutMode } = startBody({ prompt: 'hello there' });
    const response = await call('POST', '/sessions', withoutMode);
    assert.equal(response.status, 201);
    assert.equal(response.body.data.billing, 'cap');
    assert.equal(response.body.data.model, 'default');
    assert.equal(response.body.data.taskId, null);
    assert.equal(world.startedTurns[0].options.model, 'default@cap');
    assert.equal(world.startedTurns[0].options.permissionMode, 'default');
    assert.equal(world.state.get('new-1')?.billing, 'cap');
    // No API key is needed for a cap session, so the default start works without one.
    world.apiKeyAvailable = false;
    assert.equal((await call('POST', '/sessions', startBody({ prompt: 'again' }))).status, 201);
  });
});

test('POST /sessions with subscription billing sends the plain model (no @api marker)', async () => {
  await withBridge(async ({ call, world }) => {
    world.apiKeyAvailable = false; // irrelevant for the subscription
    const response = await call('POST', '/sessions', startBody({ prompt: 'hi', model: 'opus@api', billing: 'subscription' }));
    assert.equal(response.status, 201);
    assert.equal(world.startedTurns[0].options.model, 'opus');
    assert.equal(response.body.data.billing, 'subscription');
  });
});

test('POST /sessions accepts cap billing: the @cap marker goes to the run and no API key is needed', async () => {
  await withBridge(async ({ call, world }) => {
    world.apiKeyAvailable = false; // cap sessions never read the key file
    const response = await call('POST', '/sessions', startBody({
      prompt: 'Implement the form',
      model: 'claude-sonnet-5-5',
      billing: 'cap',
      permissionMode: 'acceptEdits',
      taskId: 'task-7',
      effort: 'high',
    }));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.billing, 'cap');
    assert.equal(response.body.data.model, 'claude-sonnet-5-5');
    assert.equal(world.startedTurns.length, 1);
    assert.equal(world.startedTurns[0].options.model, 'claude-sonnet-5-5@cap');
    assert.equal(world.startedTurns[0].options.effort, 'high');
    // The bridge remembers the billing, so a resume after a restart is still a cap run.
    assert.equal(world.state.get('new-1')?.billing, 'cap');
    assert.equal(world.stateRows.get('new-1')?.billing, 'cap');
  });
});

test('POST /sessions: an explicit billing wins over the marker of the model, a marked model without billing keeps its marker, an unmarked one goes through cap', async () => {
  await withBridge(async ({ call, world }) => {
    const base = startBody({ prompt: 'hi' });
    // @cap alone: stays cap (it must not turn into the default api-key billing).
    const inferred = await call('POST', '/sessions', { ...base, model: 'sonnet@cap' });
    assert.equal(inferred.body.data.billing, 'cap');
    assert.equal(world.startedTurns[0].options.model, 'sonnet@cap');
    // @api alone stays api-key; an unmarked model with no billing goes through claude-cap, the worker default.
    assert.equal((await call('POST', '/sessions', { ...base, model: 'sonnet@api' })).body.data.billing, 'api-key');
    assert.equal(world.startedTurns[1].options.model, 'sonnet@api');
    assert.equal((await call('POST', '/sessions', { ...base, model: 'sonnet' })).body.data.billing, 'cap');
    assert.equal(world.startedTurns[2].options.model, 'sonnet@cap');
    // An explicit billing replaces the marker rather than stacking one.
    assert.equal((await call('POST', '/sessions', { ...base, model: 'sonnet@api', billing: 'cap' })).body.data.billing, 'cap');
    assert.equal(world.startedTurns[3].options.model, 'sonnet@cap');
    assert.equal((await call('POST', '/sessions', { ...base, model: 'sonnet@cap', billing: 'subscription' })).body.data.billing, 'subscription');
    assert.equal(world.startedTurns[4].options.model, 'sonnet');
    assert.equal((await call('POST', '/sessions', { ...base, model: 'sonnet@cap', billing: 'api-key' })).body.data.billing, 'api-key');
    assert.equal(world.startedTurns[5].options.model, 'sonnet@api');
  });
});

test('POST /sessions rejects bad input without starting anything', async () => {
  await withBridge(async ({ call, world }) => {
    // Every case carries a good sandbox, which is checked first: what is asserted is the other field's own error.
    const valid = startBody({ prompt: 'do it' });
    const cases: Array<[string, Record<string, unknown>, number, string?]> = [
      ['missing projectPath', { ...valid, projectPath: undefined }, 400],
      ['relative projectPath', { ...valid, projectPath: 'known' }, 400],
      ['missing prompt', { ...valid, prompt: undefined }, 400],
      ['blank prompt', { ...valid, prompt: '   ' }, 400],
      ['non-string prompt', { ...valid, prompt: 5 }, 400],
      ['bad billing', { ...valid, billing: 'free' }, 400],
      ['billing in the wrong case', { ...valid, billing: 'CAP' }, 400],
      ['billing that is not a string', { ...valid, billing: ['cap'] }, 400],
      ['two billing markers', { ...valid, model: 'sonnet@api@cap' }, 400],
      ['unknown billing marker', { ...valid, model: 'sonnet@free' }, 400],
      ['bad permission mode', { ...valid, permissionMode: 'yolo' }, 400],
      ['bad model', { ...valid, model: 'sonnet; rm -rf /' }, 400],
      ['bad effort', { ...valid, effort: 'MAX!' }, 400],
      ['bad task id', { ...valid, taskId: 'has space' }, 400],
      ['unknown project', { ...valid, projectPath: '/mnt/dev/unknown' }, 422, 'UNKNOWN_PROJECT'],
      ['archived project', { ...valid, projectPath: '/mnt/dev/archived' }, 422, 'UNKNOWN_PROJECT'],
    ];
    for (const [name, body, status, code] of cases) {
      const response = await call('POST', '/sessions', body);
      assert.equal(response.status, status, name);
      assert.equal(response.body.success, false, name);
      if (code) assert.equal(response.body.error.code, code, name);
    }
    assert.equal(world.created.length, 0);
    assert.equal(world.startedTurns.length, 0);
    assert.equal(world.stateRows.size, 0, 'a refused start leaves nothing in the state');
    assert.equal(world.managedMarks.length, 0);
  });
});

test('a request body that is not a JSON object is rejected', async () => {
  await withBridge(async ({ baseUrl }) => {
    for (const raw of ['[1,2]', '"text"', '42', 'null']) {
      const response = await fetch(`${baseUrl}/api/foreman/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: raw,
      });
      // express.json() (strict mode) rejects bare primitives itself; arrays reach the route.
      assert.ok(response.status === 400, `${raw} -> ${response.status}`);
    }
  });
});

test('POST /sessions refuses API-key billing when no key file is available', async () => {
  await withBridge(async ({ call, world }) => {
    world.apiKeyAvailable = false;
    const response = await call('POST', '/sessions', startBody({ prompt: 'x', billing: 'api-key' }));
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'API_KEY_UNAVAILABLE');
    assert.equal(world.created.length, 0);
    assert.equal(world.stateRows.size, 0);
  });
});

test('POST /sessions reports a turn the runtime refuses immediately', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => ({ started: false, error: 'Provider "claude" is not available.' });
    const refused = await call('POST', '/sessions', startBody({ prompt: 'x' }));
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error.code, 'TURN_START_FAILED');

    world.turnOutcome = async () => { throw new Error('spawn failed'); };
    const crashed = await call('POST', '/sessions', startBody({ prompt: 'x' }));
    assert.equal(crashed.status, 502);
    assert.match(crashed.body.error.message, /spawn failed/);

    world.turnOutcome = async () => ({ started: true, error: 'ENOENT: no such file' });
    const failedFast = await call('POST', '/sessions', startBody({ prompt: 'x' }));
    assert.equal(failedFast.status, 502);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/message
// ---------------------------------------------------------------------------------------------

test('POST message to an idle session starts a resume turn with the settings the UI would send', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-opus-5-5@api', effort: 'xhigh' }));

    const response = await call('POST', '/sessions/s1/message', { text: 'Now add tests', permissionMode: 'acceptEdits' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body.data, { sessionId: 's1', accepted: true, interrupted: false });

    assert.equal(world.startedTurns.length, 1);
    const turn = world.startedTurns[0];
    assert.equal(turn.sessionId, 's1');
    assert.equal(turn.content, 'Now add tests');
    assert.equal(turn.interruptActiveRun, false);
    assert.equal(turn.options.model, 'claude-opus-5-5@api');
    assert.equal(turn.options.effort, 'xhigh');
    assert.equal(turn.options.permissionMode, 'acceptEdits');

    // The permission mode is remembered for the next message.
    await tick();
    await call('POST', '/sessions/s1/message', { text: 'And docs' });
    assert.equal(world.startedTurns[1].options.permissionMode, 'acceptEdits');
  });
});

test('POST message while a turn runs is refused unless it asks to interrupt', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet' }));
    world.processing.add('s1');

    const refused = await call('POST', '/sessions/s1/message', { text: 'steer' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'RUN_IN_PROGRESS');
    assert.equal(world.startedTurns.length, 0);

    const steered = await call('POST', '/sessions/s1/message', { text: 'steer', interrupt: true });
    assert.equal(steered.status, 202);
    assert.equal(steered.body.data.interrupted, true);
    assert.equal(world.startedTurns[0].interruptActiveRun, true);
  });
});

test('POST message maps a lost admission race to 409', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.turnOutcome = async () => ({ started: false, error: 'A run is already in progress for this session.' });
    const response = await call('POST', '/sessions/s1/message', { text: 'hello' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'RUN_IN_PROGRESS');
  });
});

test('POST message validates the session and the body', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    assert.equal((await call('POST', '/sessions/nope/message', { text: 'x' })).status, 404);
    assert.equal((await call('POST', '/sessions/codex/message', { text: 'x' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', {})).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: '  ' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x'.repeat(200_001) })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x', interrupt: 'yes' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x', permissionMode: 'nope' })).status, 400);
    assert.equal(world.startedTurns.length, 0);
  });
});

test('POST message to an idle API-key session needs the key file', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet@api' }));
    world.apiKeyAvailable = false;
    const response = await call('POST', '/sessions/s1/message', { text: 'x' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'API_KEY_UNAVAILABLE');

    // A live process already has its billing; it does not need the key again.
    world.live.add('s1');
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x' })).status, 202);
  });
});

test('POST message to an idle cap session resumes it as a cap run, with no API key file needed', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-sonnet-5-5@cap', effort: 'high' }));
    world.apiKeyAvailable = false;
    const response = await call('POST', '/sessions/s1/message', { text: 'Carry on' });
    assert.equal(response.status, 202);
    // The stored model still carries the marker, so the runtime builds the cap environment again.
    assert.equal(world.startedTurns[0].options.model, 'claude-sonnet-5-5@cap');
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((session: { id: string }) => session.id === 's1').billing, 'cap');
  });
});

test('GET /sessions reports cap billing and the plain model of a cap session', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('capped', row({ session_id: 'capped', model: 'claude-opus-5-5[1m]@cap' }));
    const listed = await call('GET', '/sessions');
    const capped = listed.body.data.sessions.find((session: { id: string }) => session.id === 'capped');
    assert.equal(capped.billing, 'cap');
    assert.equal(capped.model, 'claude-opus-5-5[1m]');
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/interrupt
// ---------------------------------------------------------------------------------------------

test('POST interrupt stops the run the way the UI Stop button does', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    world.live.add('s1');

    const response = await call('POST', '/sessions/s1/interrupt');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionId: 's1', interrupted: true, wasRunning: true, hadLiveProcess: true });
    assert.deepEqual(world.aborted, ['s1']);
    assert.deepEqual(world.completedRuns, [{ sessionId: 's1', exitCode: 0, aborted: true }]);
  });
});

test('POST interrupt also stops a process held open after its turn, and reports a failed abort', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('held', row({ session_id: 'held' }));
    world.live.add('held');
    const held = await call('POST', '/sessions/held/interrupt');
    assert.equal(held.status, 200);
    assert.equal(held.body.data.wasRunning, false);
    assert.equal(held.body.data.hadLiveProcess, true);

    world.rows.set('stuck', row({ session_id: 'stuck' }));
    world.processing.add('stuck');
    world.abortResult = false;
    const stuck = await call('POST', '/sessions/stuck/interrupt');
    assert.equal(stuck.status, 200);
    assert.equal(stuck.body.data.interrupted, false);
    assert.deepEqual(world.completedRuns.at(-1), { sessionId: 'stuck', exitCode: 1, aborted: true });
  });
});

test('POST interrupt on a session with nothing running is a 409, an unknown session a 404', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('idle', row({ session_id: 'idle' }));
    const idle = await call('POST', '/sessions/idle/interrupt');
    assert.equal(idle.status, 409);
    assert.equal(idle.body.error.code, 'NOT_RUNNING');
    assert.equal(world.aborted.length, 0);
    assert.equal((await call('POST', '/sessions/nope/interrupt')).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/model
// ---------------------------------------------------------------------------------------------

test('POST model on a live session changes the running process and records the model', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-sonnet-5-5@api' }));
    world.live.add('s1');

    const response = await call('POST', '/sessions/s1/model', { model: 'claude-opus-5-5' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionId: 's1', model: 'claude-opus-5-5', billing: 'api-key', applied: 'live' });
    // The live process gets the plain model; the row keeps the session's billing marker.
    assert.deepEqual(world.liveModelChanges, [{ sessionId: 's1', model: 'claude-opus-5-5' }]);
    assert.deepEqual(world.modelChanges, [{ sessionId: 's1', model: 'claude-opus-5-5@api' }]);
  });
});

test('POST model on an idle session takes effect on the next run and keeps the billing mode', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('sub', row({ session_id: 'sub', model: 'sonnet' }));
    const response = await call('POST', '/sessions/sub/model', { model: 'opus@api' });
    assert.equal(response.status, 200);
    // An @api marker in the request cannot change a subscription session's billing.
    assert.deepEqual(response.body.data, { sessionId: 'sub', model: 'opus', billing: 'subscription', applied: 'next_run' });
    assert.deepEqual(world.modelChanges, [{ sessionId: 'sub', model: 'opus' }]);
    assert.equal(world.liveModelChanges.length, 0);
  });
});

test('POST model keeps a cap session on cap, live or idle, whatever marker the request carries', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('c1', row({ session_id: 'c1', model: 'claude-sonnet-5-5@cap' }));
    world.live.add('c1');
    const live = await call('POST', '/sessions/c1/model', { model: 'claude-opus-5-5' });
    assert.deepEqual(live.body.data, { sessionId: 'c1', model: 'claude-opus-5-5', billing: 'cap', applied: 'live' });
    // The live process gets the plain Claude name; the row keeps the marker.
    assert.deepEqual(world.liveModelChanges, [{ sessionId: 'c1', model: 'claude-opus-5-5' }]);
    assert.deepEqual(world.modelChanges, [{ sessionId: 'c1', model: 'claude-opus-5-5@cap' }]);

    // An @api marker (or @cap on an api-key session) in the request cannot change the session's billing.
    world.rows.set('c2', row({ session_id: 'c2', model: 'sonnet@cap' }));
    const idle = await call('POST', '/sessions/c2/model', { model: 'opus@api' });
    assert.deepEqual(idle.body.data, { sessionId: 'c2', model: 'opus', billing: 'cap', applied: 'next_run' });
    assert.deepEqual(world.modelChanges.at(-1), { sessionId: 'c2', model: 'opus@cap' });
    world.rows.set('k1', row({ session_id: 'k1', model: 'sonnet@api' }));
    const keyed = await call('POST', '/sessions/k1/model', { model: 'opus@cap' });
    assert.deepEqual(keyed.body.data, { sessionId: 'k1', model: 'opus', billing: 'api-key', applied: 'next_run' });
    assert.deepEqual(world.modelChanges.at(-1), { sessionId: 'k1', model: 'opus@api' });
  });
});

test('POST model validates its input', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    assert.equal((await call('POST', '/sessions/s1/model', {})).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: '' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: 'a b' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: 7 })).status, 400);
    assert.equal((await call('POST', '/sessions/nope/model', { model: 'sonnet' })).status, 404);
    assert.equal(world.modelChanges.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/compact
// ---------------------------------------------------------------------------------------------

test('POST compact sends /compact with the instructions as a user turn', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet@api' }));

    const response = await call('POST', '/sessions/s1/compact', { instructions: 'Keep the task notes and the failing test names.' });
    assert.equal(response.status, 202);
    assert.equal(response.body.data.accepted, true);
    assert.equal(response.body.data.command, '/compact Keep the task notes and the failing test names.');
    assert.equal(world.startedTurns[0].content, '/compact Keep the task notes and the failing test names.');
    assert.equal(world.startedTurns[0].options.model, 'sonnet@api');
  });
});

test('POST compact without instructions sends a bare /compact', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    await call('POST', '/sessions/s1/compact', {});
    await tick();
    await call('POST', '/sessions/s1/compact', { instructions: '   ' });
    assert.deepEqual(world.startedTurns.map((turn) => turn.content), ['/compact', '/compact']);
  });
});

test('POST compact is refused while a turn runs and validates its input', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    const busy = await call('POST', '/sessions/s1/compact', { instructions: 'x' });
    assert.equal(busy.status, 409);
    world.processing.clear();

    assert.equal((await call('POST', '/sessions/s1/compact', { instructions: 5 })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/compact', { instructions: 'x'.repeat(8001) })).status, 400);
    assert.equal((await call('POST', '/sessions/nope/compact', {})).status, 404);
    assert.equal(world.startedTurns.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The sandbox of a started session (it replaces the guard)
// ---------------------------------------------------------------------------------------------

const nothingStarted = (world: World) => {
  assert.equal(world.created.length, 0, 'no session was allocated');
  assert.equal(world.startedTurns.length, 0, 'no turn was started');
  assert.equal(world.stateRows.size, 0, 'nothing was remembered');
  assert.equal(world.managedMarks.length, 0);
  assert.equal(world.announced.length, 0);
  assert.equal(world.idempotencyStorage.rows.size, 0, 'the key of a refused call is not burned');
};

test('POST /sessions without a sandbox is refused with SANDBOX_REQUIRED, and nothing starts', async () => {
  await withBridge(async ({ call, world }) => {
    for (const sandbox of [undefined, null]) {
      const response = await call('POST', '/sessions', startBody({ sandbox }));
      assert.equal(response.status, 400, String(sandbox));
      assert.equal(response.body.error.code, 'SANDBOX_REQUIRED');
    }
    // The sandbox is the first thing read: a start that is wrong in other ways says so about the sandbox, not about the project.
    const first = await call('POST', '/sessions', startBody({ projectPath: '/mnt/dev/unknown', billing: 'free', sandbox: undefined }));
    assert.equal(first.status, 400);
    assert.equal(first.body.error.code, 'SANDBOX_REQUIRED');
    nothingStarted(world);
  });
});

test('POST /sessions refuses a malformed sandbox with SANDBOX_INVALID, and nothing starts', async () => {
  await withBridge(async ({ call, world }) => {
    const { network: _network, ...withoutNetwork } = samplePolicy();
    const bad: Array<[string, unknown]> = [
      ['not an object', 'on'],
      ['an array', []],
      ['relative scratchDir', samplePolicy({ scratchDir: 'scratch/batch-1' })],
      ['scratchDir of /', samplePolicy({ scratchDir: '/' })],
      ['no network', withoutNetwork],
      ['allow list of the wrong type', samplePolicy({ permissions: { allow: 'Bash' as never, deny: [] } })],
      ['approval window below a second', samplePolicy({ approvalTimeoutMs: 5 })],
      ['a credential that is not denied', samplePolicy({ credentials: { envVars: [{ name: 'GH_TOKEN', mode: 'allow' as never }] } })],
      ['an env value that is not a string', samplePolicy({ env: { TMPDIR: 3 as never } })],
    ];
    for (const [label, sandbox] of bad) {
      const response = await call('POST', '/sessions', startBody({ sandbox }));
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, 'SANDBOX_INVALID', label);
    }
    nothingStarted(world);
  });
});

test('POST /sessions with a good sandbox starts a sandboxed session: the policy is stored and the starting commit recorded before the run', async () => {
  await withBridge(async ({ call, world }) => {
    let storedWhenTheRunStarted: unknown = 'the run never started';
    world.turnOutcome = async () => {
      storedWhenTheRunStarted = world.state.sandboxOf('new-1');
      return { started: true, error: null };
    };
    const policy = samplePolicy({ scratchDir: '/mnt/dev/scratch/task-5', approvalTimeoutMs: null });
    const response = await call('POST', '/sessions', startBody({ sandbox: policy, taskId: 'task-5' }));

    assert.equal(response.status, 201);
    assert.equal(response.body.data.sandboxed, true);
    const sessionId = response.body.data.sessionId as string;
    // What the run reads back through the sandbox provider is the policy that was sent, and it was there when the run began.
    assert.deepEqual(world.state.sandboxOf(sessionId), { policy, scope: KNOWN_SCOPE });
    assert.deepEqual(storedWhenTheRunStarted, { policy, scope: KNOWN_SCOPE });
    assert.deepEqual(JSON.parse(world.stateRows.get(sessionId)?.sandbox_json ?? 'null'), policy);

    const state = world.state.get(sessionId);
    assert.equal(state?.supervision, 'started');
    assert.equal(state?.baseHead, HEAD);
    assert.equal(state?.baseSequence, 0);
    assert.equal(state?.taskId, 'task-5');
    assert.deepEqual(world.headCalls, ['/mnt/dev/known']);

    // The sandbox does not travel with the turn: a caller cannot drop it from a later run, the run asks for the stored one.
    assert.deepEqual(Object.keys(world.startedTurns[0].options).sort(), ['effort', 'foremanDispatch', 'foremanSandbox', 'model', 'permissionMode', 'sessionSummary']);

    const listed = (await call('GET', '/sessions')).body.data.sessions.find((entry: { id: string }) => entry.id === sessionId);
    assert.equal(listed.sandboxed, true);
    assert.equal(listed.supervision, 'started');
  });
});

test('POST /sessions records no starting commit for a project that has none, and still starts it', async () => {
  await withBridge(async ({ call, world }) => {
    world.head = null;
    const response = await call('POST', '/sessions', startBody());
    assert.equal(response.status, 201);
    assert.equal(world.state.get(response.body.data.sessionId)?.baseHead, null);
  });
});

test('the guard is gone: a body with a guard and no sandbox does not start, and a guard next to a sandbox is ignored', async () => {
  await withBridge(async ({ call, world }) => {
    const guard = { enabled: true, riskyPatterns: ['\\bgit\\s+push\\b'], secretPatterns: [], writeOutsideRepo: true };
    const refused = await call('POST', '/sessions', startBody({ guard, sandbox: undefined }));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'SANDBOX_REQUIRED');
    nothingStarted(world);

    const started = await call('POST', '/sessions', startBody({ guard }));
    assert.equal(started.status, 201);
    assert.equal('guard' in started.body.data, false);
    assert.equal('guarded' in started.body.data, false);
    assert.equal('toolPolicy' in world.startedTurns[0].options, false);
    assert.equal('toolHooks' in world.startedTurns[0].options, false);
    assert.equal('guard' in (world.state.get(started.body.data.sessionId) ?? {}), false);
    // The stored sandbox is the one sent, whatever the guard said.
    assert.deepEqual(world.state.sandboxOf(started.body.data.sessionId), { policy: samplePolicy(), scope: KNOWN_SCOPE });
  });
});

test('a message to a sandboxed session can change its permission mode and never touches its sandbox', async () => {
  await withBridge(async ({ call, world }) => {
    const started = await call('POST', '/sessions', startBody({ permissionMode: 'default' }));
    const sessionId = started.body.data.sessionId as string;
    await tick();

    const response = await call('POST', `/sessions/${sessionId}/message`, { text: 'go on', permissionMode: 'acceptEdits' });
    assert.equal(response.status, 202);
    assert.equal(world.startedTurns[1].options.permissionMode, 'acceptEdits');
    assert.equal(world.state.get(sessionId)?.permissionMode, 'acceptEdits');
    assert.deepEqual(world.state.sandboxOf(sessionId), { policy: samplePolicy(), scope: KNOWN_SCOPE });
    assert.equal('sandbox' in world.startedTurns[1].options, false);

    // The next message without a mode resumes in the remembered one.
    await tick();
    await call('POST', `/sessions/${sessionId}/message`, { text: 'and docs' });
    assert.equal(world.startedTurns[2].options.permissionMode, 'acceptEdits');
  });
});

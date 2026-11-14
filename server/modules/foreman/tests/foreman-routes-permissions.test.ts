import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';

import { createBridgeServices, row, startBody, tick, withBridge } from './foreman-routes-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';


// ---------------------------------------------------------------------------------------------
// Milestone 5: pending permission prompts
// ---------------------------------------------------------------------------------------------

test('GET /sessions/:id/permissions lists what is pending, with a clipped input and the time it was asked', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.live.add('s1');

    const none = await call('GET', '/sessions/s1/permissions');
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.data, { permissions: [] });

    world.approvals.set('s1', [
      { requestId: 'req-1', toolName: 'Bash', input: { command: `git push origin main ${'x'.repeat(2000)}` }, receivedAt: new Date('2026-11-13T09:00:00.000Z') },
      { requestId: 'req-2', toolName: 'Read', input: { file_path: '/repo/.env' }, receivedAt: new Date('2026-11-13T09:00:05.000Z') },
      { toolName: 'Broken' },
    ]);
    const pending = await call('GET', '/sessions/s1/permissions');
    assert.equal(pending.status, 200);
    const permissions = pending.body.data.permissions as Array<{ requestId: string; toolName: string; input: string; askedAt: string }>;
    assert.deepEqual(permissions.map((entry) => [entry.requestId, entry.toolName, entry.askedAt]), [
      ['req-1', 'Bash', '2026-11-13T09:00:00.000Z'],
      ['req-2', 'Read', '2026-11-13T09:00:05.000Z'],
    ]);
    assert.ok(permissions[0].input.startsWith('git push origin main xxx'));
    assert.ok(permissions[0].input.length <= 1000);
    assert.equal(permissions[1].input, '/repo/.env');
    assert.deepEqual(Object.keys(permissions[0]).sort(), ['askedAt', 'input', 'requestId', 'toolName']);

    // The session reports waiting_permission while anything is pending.
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((entry: { id: string }) => entry.id === 's1').status, 'waiting_permission');
  });
});

test('GET /sessions/:id/permissions validates the session', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    assert.equal((await call('GET', '/sessions/missing/permissions')).status, 404);
    assert.equal((await call('GET', '/sessions/missing/permissions')).body.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await call('GET', '/sessions/codex/permissions')).status, 400);
    assert.equal((await call('GET', `/sessions/${encodeURIComponent('bad id')}/permissions`)).status, 400);
  });
});

test('POST /sessions/:id/permission allows a pending prompt, and the session leaves waiting_permission', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.approvals.set('s1', [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'git push' }, receivedAt: new Date() }]);

    const response = await call('POST', '/sessions/s1/permission', { requestId: 'req-1', decision: 'allow' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { resolved: true });
    assert.deepEqual(world.resolvedPermissions, [{ requestId: 'req-1', decision: { allow: true } }]);

    assert.deepEqual((await call('GET', '/sessions/s1/permissions')).body.data, { permissions: [] });
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((entry: { id: string }) => entry.id === 's1').status, 'idle');
  });
});

test('POST /sessions/:id/permission denies with the reason, or with a default one', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.approvals.set('s1', [
      { requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() },
      { requestId: 'req-2', toolName: 'Bash', input: {}, receivedAt: new Date() },
    ]);

    const withReason = await call('POST', '/sessions/s1/permission', { requestId: 'req-1', decision: 'deny', reason: 'Pushing is not part of this task.' });
    assert.deepEqual(withReason.body.data, { resolved: true });
    // Another prompt is still pending, so the session is still waiting.
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((entry: { id: string }) => entry.id === 's1').status, 'waiting_permission');

    await call('POST', '/sessions/s1/permission', { requestId: 'req-2', decision: 'deny' });
    assert.deepEqual(world.resolvedPermissions, [
      { requestId: 'req-1', decision: { allow: false, message: 'Pushing is not part of this task.' } },
      { requestId: 'req-2', decision: { allow: false, message: 'Denied by the Foreman supervisor.' } },
    ]);
  });
});

test('POST /sessions/:id/permission answers 404 NO_PENDING_PERMISSION when the request is not pending', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('s2', row({ session_id: 's2' }));
    world.approvals.set('s1', [{ requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() }]);

    // Unknown request id.
    const unknown = await call('POST', '/sessions/s1/permission', { requestId: 'req-nope', decision: 'allow' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NO_PENDING_PERMISSION');
    // A request of another session is not this session's to answer.
    const wrongSession = await call('POST', '/sessions/s2/permission', { requestId: 'req-1', decision: 'allow' });
    assert.equal(wrongSession.status, 404);
    assert.equal(wrongSession.body.error.code, 'NO_PENDING_PERMISSION');
    assert.deepEqual(world.resolvedPermissions, []);

    // Whoever answers first wins: the chat UI answered, so the bridge's answer finds nothing pending.
    world.approvals.set('s1', []);
    const late = await call('POST', '/sessions/s1/permission', { requestId: 'req-1', decision: 'allow' });
    assert.equal(late.status, 404);
    assert.equal(late.body.error.code, 'NO_PENDING_PERMISSION');

    // Answering twice: the second answer is the late one.
    world.approvals.set('s1', [{ requestId: 'req-2', toolName: 'Bash', input: {}, receivedAt: new Date() }]);
    assert.equal((await call('POST', '/sessions/s1/permission', { requestId: 'req-2', decision: 'allow' })).status, 200);
    assert.equal((await call('POST', '/sessions/s1/permission', { requestId: 'req-2', decision: 'allow' })).status, 404);
    assert.equal(world.resolvedPermissions.length, 1);
  });
});

test('POST /sessions/:id/permission validates the session and the body', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    world.approvals.set('s1', [{ requestId: 'req-1', toolName: 'Bash', input: {}, receivedAt: new Date() }]);

    assert.equal((await call('POST', '/sessions/missing/permission', { requestId: 'req-1', decision: 'allow' })).status, 404);
    assert.equal((await call('POST', '/sessions/codex/permission', { requestId: 'req-1', decision: 'allow' })).status, 400);
    const bad: unknown[] = [
      {},
      { decision: 'allow' },
      { requestId: 'req-1' },
      { requestId: '', decision: 'allow' },
      { requestId: 42, decision: 'allow' },
      { requestId: 'has space', decision: 'allow' },
      { requestId: 'req-1', decision: 'maybe' },
      { requestId: 'req-1', decision: true },
      { requestId: 'req-1', decision: 'deny', reason: 5 },
      { requestId: 'req-1', decision: 'deny', reason: 'x'.repeat(1001) },
      [],
    ];
    for (const body of bad) {
      const response = await call('POST', '/sessions/s1/permission', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.success, false);
    }
    assert.deepEqual(world.resolvedPermissions, []);
    assert.equal(world.approvals.get('s1')?.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Milestone 5: status, permission mode and sandbox across a cloudcli restart
// ---------------------------------------------------------------------------------------------

test('after a restart a resumed Foreman session keeps its permission mode, its sandbox and its supervision', async () => {
  await withBridge(async ({ call, world, deps }) => {
    const policy = samplePolicy({ approvalTimeoutMs: 600_000 });
    const started = await call('POST', '/sessions', startBody({ permissionMode: 'plan', taskId: 'task-9', sandbox: policy }));
    const sessionId = started.body.data.sessionId as string;
    await tick();
    world.state.setStatus(sessionId, 'running');

    // "Restart": a brand-new bridge over the same store, with the in-memory pieces of the old process gone.
    const restartedState = createForemanSessionStateService({ store: world.stateStore });
    const restarted = createBridgeServices({
      ...deps,
      state: restartedState,
      taskIds: createTaskIdStore({ get: () => null, set: () => undefined }),
    });
    const [summary] = restarted.reads.listSessions().filter((entry) => entry.id === sessionId);
    assert.equal(summary.status, 'idle', 'the run died with the process');
    assert.equal(summary.permissionMode, 'plan');
    assert.equal(summary.sandboxed, true);
    assert.equal(summary.supervision, 'started');
    assert.equal(summary.taskId, 'task-9', 'the task link is also read back from the stored state');

    await restarted.sessions.sendMessage(sessionId, { text: 'Carry on', interrupt: false });
    const resumed = world.startedTurns.at(-1);
    assert.equal(resumed?.sessionId, sessionId);
    assert.equal(resumed?.options.permissionMode, 'plan');
    // The resumed run asks the stored state for its sandbox (the request carries none), and the approval window is the one sent.
    assert.deepEqual(restartedState.sandboxOf(sessionId), { policy });
    assert.equal('sandbox' in (resumed?.options ?? {}), false);
  });
});

test('a message that names a permission mode changes the remembered one, and a restart keeps it', async () => {
  await withBridge(async ({ call, world, deps }) => {
    world.rows.set('ui', row({ session_id: 'ui', model: 'sonnet@api' }));
    assert.equal(world.state.get('ui')?.permissionMode, null);

    await call('POST', '/sessions/ui/message', { text: 'first', permissionMode: 'acceptEdits' });
    const tracked = world.state.get('ui');
    assert.equal(tracked?.permissionMode, 'acceptEdits');
    assert.equal(tracked?.sandboxJson, null, 'a session without a sandbox stays without one');

    const restarted = createBridgeServices({ ...deps, state: createForemanSessionStateService({ store: world.stateStore }) });
    await tick();
    await restarted.sessions.sendMessage('ui', { text: 'second', interrupt: false });
    assert.equal(world.startedTurns.at(-1)?.options.permissionMode, 'acceptEdits');
  });
});

test('GET /sessions reports the remembered status for sessions without a live process', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('failed-before-restart', row({ session_id: 'failed-before-restart' }));
    world.rows.set('plain', row({ session_id: 'plain' }));
    world.state.track('failed-before-restart', { permissionMode: 'default' });
    world.state.setStatus('failed-before-restart', 'error');
    world.state.track('plain', {});

    const listed = await call('GET', '/sessions');
    const byId = Object.fromEntries((listed.body.data.sessions as Array<{ id: string; status: string; live: boolean }>).map((entry) => [entry.id, entry]));
    assert.equal(byId['failed-before-restart'].status, 'error');
    assert.equal(byId['failed-before-restart'].live, false);
    assert.equal(byId.plain.status, 'idle');

    // What is live right now wins over what was remembered.
    world.processing.add('failed-before-restart');
    const running = await call('GET', '/sessions');
    assert.equal(running.body.data.sessions.find((entry: { id: string }) => entry.id === 'failed-before-restart').status, 'running');
  });
});

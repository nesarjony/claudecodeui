import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, foremanSessionStateDb, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { compileGuard, createToolPolicy, type ForemanGuardConfig } from '@/modules/foreman/foreman-guard.service.js';
import {
  createForemanSessionStateService,
  type ForemanSessionStateStore,
} from '@/modules/foreman/foreman-session-state.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'foreman-state-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const GUARD: ForemanGuardConfig = {
  enabled: true,
  riskyPatterns: ['\\bgit\\s+push\\b'],
  secretPatterns: ['(^|/)\\.env$'],
  writeOutsideRepo: true,
  repoRoot: '/mnt/dev/repo',
};

const base = { sessionId: 's1', projectPath: '/mnt/dev/repo' };
const started = (sessionId = 's1'): ClaudeRuntimeEvent => ({ ...base, sessionId, kind: 'run_started', resumed: false, model: null, permissionMode: 'default' });
const asked = (requestId: string, sessionId = 's1'): ClaudeRuntimeEvent => ({ ...base, sessionId, kind: 'permission_request', requestId, toolName: 'Bash', input: {}, guarded: true, category: 'command' });
const resolved = (requestId: string, sessionId = 's1'): ClaudeRuntimeEvent => ({ ...base, sessionId, kind: 'permission_resolved', requestId });
const turn = (isError = false): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message: { type: 'result', is_error: isError }, model: null, toolCalls: 0, toolErrors: 0 });
const ended = (reason: 'completed' | 'aborted' | 'error'): ClaudeRuntimeEvent => ({ ...base, kind: 'run_ended', reason });

function newService(log: string[] = []) {
  return createForemanSessionStateService({ store: foremanSessionStateDb, log: (message) => log.push(message) });
}

// ---------------------------------------------------------------------------------------------

test('the foreman_session_state table is created with the database', async () => {
  await withIsolatedDatabase(() => {
    const columns = (getConnection().prepare('PRAGMA table_info(foreman_session_state)').all() as Array<{ name: string; pk: number }>);
    assert.deepEqual(columns.map((column) => column.name), ['session_id', 'task_id', 'status', 'permission_mode', 'billing', 'guard_json', 'updated_at']);
    assert.equal(columns.find((column) => column.name === 'session_id')?.pk, 1);
  });
});

test('track stores task, billing, permission mode and guard; later patches change only what they name', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    assert.equal(state.get('s1'), null);

    state.track('s1', { taskId: 'task-1', billing: 'api-key', permissionMode: 'default', guard: GUARD });
    assert.deepEqual(
      { ...state.get('s1'), updatedAt: undefined },
      { sessionId: 's1', taskId: 'task-1', status: 'idle', permissionMode: 'default', billing: 'api-key', guard: GUARD, updatedAt: undefined },
    );

    state.track('s1', { permissionMode: 'plan' });
    assert.equal(state.get('s1')?.permissionMode, 'plan');
    assert.equal(state.get('s1')?.taskId, 'task-1');
    assert.deepEqual(state.get('s1')?.guard, GUARD);

    state.track('s1', { guard: null });
    assert.equal(state.get('s1')?.guard, null);

    // What is stored is what a reader gets back.
    const row = foremanSessionStateDb.get('s1');
    assert.equal(row?.permission_mode, 'plan');
    assert.equal(row?.guard_json, null);
    assert.equal(row?.task_id, 'task-1');
  });
});

test('after a restart a new service reads the same state: mode, guard and task survive, running becomes idle', async () => {
  await withIsolatedDatabase(() => {
    const before = newService();
    before.track('running-one', { taskId: 'task-7', billing: 'subscription', permissionMode: 'plan', guard: GUARD });
    before.setStatus('running-one', 'running');
    before.track('waiting-one', { permissionMode: 'default' });
    before.setStatus('waiting-one', 'waiting_permission');
    before.track('broken-one', {});
    before.setStatus('broken-one', 'error');
    before.track('quiet-one', {});
    assert.equal(before.get('running-one')?.status, 'running');
    assert.equal(foremanSessionStateDb.get('running-one')?.status, 'running');

    // The restart: a brand-new service instance over the same database.
    const log: string[] = [];
    const after = newService(log);
    const recovered = after.recoverAfterRestart();
    assert.deepEqual(recovered, { reset: 2, waitingPermission: 1 });

    assert.equal(after.get('running-one')?.status, 'idle', 'its process is gone');
    assert.equal(after.get('waiting-one')?.status, 'idle', 'its prompt can no longer be answered');
    assert.equal(after.get('broken-one')?.status, 'error', 'an error stays an error');
    assert.equal(after.get('quiet-one')?.status, 'idle');

    const survivor = after.get('running-one');
    assert.equal(survivor?.permissionMode, 'plan');
    assert.equal(survivor?.taskId, 'task-7');
    assert.equal(survivor?.billing, 'subscription');
    assert.deepEqual(survivor?.guard, GUARD);
    assert.equal(after.get('waiting-one')?.permissionMode, 'default');

    // The guard that comes back still judges calls the same way.
    const policy = createToolPolicy(compileGuard(survivor?.guard as ForemanGuardConfig, '/mnt/dev/repo'));
    assert.equal(policy('Bash', { command: 'git push' }).decision, 'ask');
    assert.equal(policy('Bash', { command: 'git status' }).decision, 'allow');

    assert.equal(log.length, 1);
    assert.match(log[0], /restart: 2 Foreman session\(s\).*now idle/);
    assert.match(log[0], /1 of them were waiting on a permission prompt.*dropped/);
  });
});

test('recovery runs once per service and before the first read, so later running states are not reset', async () => {
  await withIsolatedDatabase(() => {
    newService().track('s1', {});
    foremanSessionStateDb.updateStatus('s1', 'running', new Date().toISOString());

    const log: string[] = [];
    const after = newService(log);
    // No explicit recovery call: the first read settles the leftovers.
    assert.equal(after.get('s1')?.status, 'idle');
    assert.equal(log.length, 1);

    after.setStatus('s1', 'running');
    assert.deepEqual(after.recoverAfterRestart(), { reset: 1, waitingPermission: 0 }, 'the first result is returned again');
    assert.equal(after.get('s1')?.status, 'running', 'a later call does not reset a live run');
    assert.equal(foremanSessionStateDb.get('s1')?.status, 'running');
    assert.equal(log.length, 1, 'and it logs only once');
  });
});

test('nothing to settle logs nothing', async () => {
  await withIsolatedDatabase(() => {
    const log: string[] = [];
    const state = newService(log);
    assert.deepEqual(state.recoverAfterRestart(), { reset: 0, waitingPermission: 0 });
    assert.deepEqual(log, []);
  });
});

test('runtime events move the status of a tracked session', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    state.track('s1', { permissionMode: 'default' });

    state.observe(started());
    assert.equal(state.get('s1')?.status, 'running');

    state.observe(asked('r1'));
    state.observe(asked('r2'));
    assert.equal(state.get('s1')?.status, 'waiting_permission');
    assert.equal(foremanSessionStateDb.get('s1')?.status, 'waiting_permission');

    // It leaves waiting_permission when the last pending request resolves, not before.
    state.observe(resolved('r1'));
    assert.equal(state.get('s1')?.status, 'waiting_permission');
    state.observe(resolved('r2'));
    assert.equal(state.get('s1')?.status, 'running');

    state.observe(turn());
    assert.equal(state.get('s1')?.status, 'idle');
    assert.equal(foremanSessionStateDb.get('s1')?.status, 'idle');

    state.observe(started());
    state.observe(turn(true));
    assert.equal(state.get('s1')?.status, 'error');
    state.observe(ended('completed'));
    assert.equal(state.get('s1')?.status, 'error', 'ending after a failed turn keeps the error');

    state.observe(started());
    assert.equal(state.get('s1')?.status, 'running', 'a new run clears the error');
    state.observe(ended('aborted'));
    assert.equal(state.get('s1')?.status, 'idle');

    state.observe(started());
    state.observe({ ...base, kind: 'run_error', message: 'spawn ENOENT' });
    assert.equal(state.get('s1')?.status, 'error');
    state.observe(started());
    state.observe(ended('error'));
    assert.equal(state.get('s1')?.status, 'error');
  });
});

test('a prompt that resolves after its run ended does not bring the session back to running', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    state.track('s1', {});
    state.observe(started());
    state.observe(asked('r1'));
    state.observe(ended('aborted'));
    assert.equal(state.get('s1')?.status, 'idle');
    state.observe(resolved('r1'));
    assert.equal(state.get('s1')?.status, 'idle');
  });
});

test('sessions the bridge does not track are ignored, and observing never throws', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    state.observe(started('ui-session'));
    state.observe(turn());
    assert.equal(state.get('ui-session'), null);
    assert.equal(foremanSessionStateDb.get('ui-session'), null);
    state.setStatus('ui-session', 'error');
    assert.equal(foremanSessionStateDb.get('ui-session'), null);
    assert.doesNotThrow(() => state.observe({ ...base, sessionId: '', kind: 'run_ended', reason: 'completed' }));
  });
});

test('runtime events of sessions the bridge does not track cost one lookup, not one per event', () => {
  let lookups = 0;
  const store: ForemanSessionStateStore = {
    get: () => { lookups += 1; return null; },
    upsert: () => undefined,
    updateStatus: () => false,
    settleAfterRestart: () => ({ reset: 0, waitingPermission: 0 }),
  };
  const state = createForemanSessionStateService({ store });
  for (let index = 0; index < 20; index += 1) {
    state.observe(started('ui-session'));
    state.observe({ ...base, sessionId: 'ui-session', kind: 'turn_result', message: { type: 'result' }, model: null, toolCalls: 0, toolErrors: 0 });
  }
  assert.equal(lookups, 1);
  // Tracking it afterwards is seen straight away.
  state.track('ui-session', {});
  state.observe(started('ui-session'));
  assert.equal(state.get('ui-session')?.status, 'running');
});

test('a failing database is logged and the bridge carries on with what it has', () => {
  const failing: ForemanSessionStateStore = {
    get: () => { throw new Error('disk I/O error'); },
    upsert: () => { throw new Error('disk I/O error'); },
    updateStatus: () => { throw new Error('disk I/O error'); },
    settleAfterRestart: () => { throw new Error('disk I/O error'); },
  };
  const log: string[] = [];
  const state = createForemanSessionStateService({ store: failing, log: (message) => log.push(message) });

  assert.equal(state.get('s1'), null);
  const tracked = state.track('s1', { permissionMode: 'default', guard: GUARD });
  assert.equal(tracked.permissionMode, 'default');
  assert.deepEqual(state.get('s1')?.guard, GUARD, 'served from memory');
  state.observe(started());
  assert.equal(state.get('s1')?.status, 'running');
  assert.ok(log.some((message) => /restart recovery failed/.test(message)));
  assert.ok(log.some((message) => /not persisted/.test(message)));
});

test('a stored guard that cannot be read asks about every shell command and path instead of waving them through', async () => {
  await withIsolatedDatabase(() => {
    foremanSessionStateDb.upsert({
      session_id: 'broken-guard',
      task_id: null,
      status: 'idle',
      permission_mode: 'default',
      billing: null,
      guard_json: '{not json',
      updated_at: new Date().toISOString(),
    });
    const log: string[] = [];
    const guard = newService(log).get('broken-guard')?.guard;
    assert.ok(guard);
    const policy = createToolPolicy(compileGuard(guard, '/mnt/dev/repo'));
    assert.equal(policy('Bash', { command: 'ls' }).decision, 'ask');
    assert.equal(policy('Read', { file_path: '/mnt/dev/repo/a.ts' }).decision, 'ask');
    assert.equal(policy('Write', { file_path: '/mnt/dev/repo/a.ts', content: '' }).decision, 'ask');
    assert.ok(log.some((message) => /unreadable/.test(message)));
  });
});

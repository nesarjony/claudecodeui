import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, foremanSessionStateDb, getConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  createForemanSessionStateService,
  type ForemanSessionStateStore,
} from '@/modules/foreman/foreman-session-state.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import { SAMPLE_SCOPE, samplePolicy } from './foreman-sandbox-support.js';

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

const SANDBOX = samplePolicy();
const RECORDED = { policy: SANDBOX, scope: SAMPLE_SCOPE };

const base = { sessionId: 's1', projectPath: '/mnt/dev/repo' };
const started = (sessionId = 's1'): ClaudeRuntimeEvent => ({ ...base, sessionId, kind: 'run_started', resumed: false, model: null, permissionMode: 'default', allowedTools: [], disallowedTools: [], foremanDispatch: true });
const asked = (requestId: string, sessionId = 's1'): ClaudeRuntimeEvent => ({ ...base, sessionId, kind: 'permission_request', requestId, toolName: 'Bash', input: {}, sandboxed: true });
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
    assert.deepEqual(columns.map((column) => column.name), ['session_id', 'task_id', 'status', 'permission_mode', 'billing', 'sandbox_json', 'supervision', 'base_head', 'base_sequence', 'updated_at', 'sandbox_scope_json', 'owner_tools_json']);
    assert.equal(columns.find((column) => column.name === 'session_id')?.pk, 1);
  });
});

test('track stores task, billing, permission mode, sandbox and where supervision began; later patches change only what they name', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    assert.equal(state.get('s1'), null);

    state.trackStrict('s1', { taskId: 'task-1', billing: 'api-key', permissionMode: 'default', sandbox: RECORDED, baseHead: 'abc', baseSequence: 4 });
    assert.deepEqual(
      { ...state.get('s1'), updatedAt: undefined },
      {
        sessionId: 's1', taskId: 'task-1', status: 'idle', permissionMode: 'default', billing: 'api-key', sandboxJson: JSON.stringify(SANDBOX),
        sandboxScopeJson: JSON.stringify(SAMPLE_SCOPE), ownerTools: null, supervision: 'started', baseHead: 'abc', baseSequence: 4, updatedAt: undefined,
      },
    );

    state.track('s1', { permissionMode: 'plan' });
    assert.equal(state.get('s1')?.permissionMode, 'plan');
    assert.equal(state.get('s1')?.taskId, 'task-1');
    assert.equal(state.get('s1')?.sandboxJson, JSON.stringify(SANDBOX));

    // What is stored is what a reader gets back.
    const row = foremanSessionStateDb.get('s1');
    assert.equal(row?.permission_mode, 'plan');
    assert.equal(row?.sandbox_json, JSON.stringify(SANDBOX));
    assert.equal(row?.task_id, 'task-1');
  });
});

test('cap billing is stored and read back, and survives a restart', async () => {
  await withIsolatedDatabase(() => {
    newService().track('cap-one', { taskId: 'task-9', billing: 'cap', permissionMode: 'acceptEdits' });
    assert.equal(foremanSessionStateDb.get('cap-one')?.billing, 'cap');
    // A later patch that does not name the billing leaves it alone.
    newService().track('cap-one', { permissionMode: 'plan' });
    const restarted = newService();
    assert.equal(restarted.get('cap-one')?.billing, 'cap');
    assert.equal(restarted.get('cap-one')?.permissionMode, 'plan');
    // A stored value this version does not know reads as unknown, not as one of the known modes.
    foremanSessionStateDb.upsert({ ...(foremanSessionStateDb.get('cap-one') as NonNullable<ReturnType<typeof foremanSessionStateDb.get>>), session_id: 'odd-one', billing: 'free' });
    assert.equal(newService().get('odd-one')?.billing, null);
  });
});

test('after a restart a new service reads the same state: mode, sandbox and task survive, running becomes idle', async () => {
  await withIsolatedDatabase(() => {
    const before = newService();
    before.trackStrict('running-one', { taskId: 'task-7', billing: 'subscription', permissionMode: 'plan', sandbox: RECORDED });
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
    assert.equal(survivor?.sandboxJson, JSON.stringify(SANDBOX));
    assert.equal(after.get('waiting-one')?.permissionMode, 'default');

    // The sandbox that comes back is the policy Foreman sent, whole.
    assert.deepEqual(after.sandboxOf('running-one'), RECORDED);
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

// The state service is the bridge's only record of a failed run, so it must set the error for a failed run or a failed turn however the CLI
// spells it, and clear it with a clean turn or a new run.
test('the error status is set by a failed run or a failed turn and cleared by a clean turn or a new run', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    state.track('s1', {});
    const failedTurn = (message: Record<string, unknown>): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message, model: null, toolCalls: 0, toolErrors: 0 });

    state.observe({ ...base, kind: 'run_error', message: 'boom' });
    assert.equal(state.get('s1')?.status, 'error');
    state.observe(started());
    assert.equal(state.get('s1')?.status, 'running', 'a new run clears it');

    state.observe(failedTurn({ is_error: true, subtype: 'error_max_turns' }));
    assert.equal(state.get('s1')?.status, 'error');
    state.observe(failedTurn({ subtype: 'success', is_error: false }));
    assert.equal(state.get('s1')?.status, 'idle', 'a clean turn clears it, with or without a new run before it');

    state.observe(failedTurn({ subtype: 'error_during_execution' }));
    assert.equal(state.get('s1')?.status, 'error', 'an error subtype alone is a failed turn');
    state.observe(failedTurn({ subtype: 'success', is_error: true }));
    assert.equal(state.get('s1')?.status, 'error', 'the flag alone is a failed turn, even under subtype success');
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
    listSupervised: () => [],
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
    listSupervised: () => { throw new Error('disk I/O error'); },
  };
  const log: string[] = [];
  const state = createForemanSessionStateService({ store: failing, log: (message) => log.push(message) });

  assert.equal(state.get('s1'), null);
  const tracked = state.track('s1', { permissionMode: 'default' });
  assert.equal(tracked.permissionMode, 'default');
  assert.equal(state.get('s1')?.permissionMode, 'default', 'served from memory');
  state.observe(started());
  assert.equal(state.get('s1')?.status, 'running');
  assert.ok(log.some((message) => /restart recovery failed/.test(message)));
  assert.ok(log.some((message) => /not persisted/.test(message)));
  assert.ok('refuse' in (state.sandboxOf('s1', { required: true }) ?? {}), 'a run of the bridge whose sandbox cannot be read is refused, it is never assumed away');
  assert.equal(state.sandboxOf('s1'), null, 'the owner\'s session is not refused because the table cannot be read');
});

function storedRow(sandboxJson: string | null, supervision: 'started' | 'adopted' | 'released' = 'started') {
  return {
    session_id: 'stored', task_id: null, status: 'idle' as const, permission_mode: 'default', billing: null, sandbox_json: sandboxJson, supervision,
    base_head: null, base_sequence: 0, updated_at: new Date().toISOString(), sandbox_scope_json: sandboxJson ? JSON.stringify(SAMPLE_SCOPE) : null, owner_tools_json: null,
  };
}

test('sandboxOf answers null for a session without a sandbox, the policy for one that has it, and refuses when it cannot be read', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    assert.equal(state.sandboxOf('never-seen'), null);
    foremanSessionStateDb.upsert(storedRow(null));
    assert.equal(state.sandboxOf('stored'), null, 'a session handed over keeps the owner\'s settings: no sandbox is added');
    foremanSessionStateDb.upsert(storedRow(JSON.stringify(SANDBOX)));
    assert.deepEqual(state.sandboxOf('stored'), RECORDED);
    for (const broken of ['{not json', JSON.stringify({ scratchDir: '/x' }), JSON.stringify({ ...SANDBOX, scratchDir: 'relative' })]) {
      foremanSessionStateDb.upsert(storedRow(broken));
      assert.match((state.sandboxOf('stored') as { refuse: string }).refuse, /malformed or no longer allowed, so it does not run/);
    }
  });
});

test('a row written without a sandbox never erases the one recorded for the session', async () => {
  await withIsolatedDatabase(() => {
    newService().trackStrict('stored', { sandbox: RECORDED });
    // A writer that could not read the row first (its read failed) writes the whole row without the sandbox.
    foremanSessionStateDb.upsert(storedRow(null, 'adopted'));
    assert.equal(foremanSessionStateDb.get('stored')?.supervision, 'adopted');
    assert.equal(foremanSessionStateDb.get('stored')?.sandbox_json, JSON.stringify(SANDBOX));
    assert.equal(foremanSessionStateDb.get('stored')?.sandbox_scope_json, JSON.stringify(SAMPLE_SCOPE), 'nor the scope recorded with it');
    assert.deepEqual(newService().sandboxOf('stored'), RECORDED);
  });
});

test('the supervised sessions are the ones started or adopted, newest first; a released one drops out', async () => {
  await withIsolatedDatabase(() => {
    const state = newService();
    state.track('started-one', { taskId: 'task-1' });
    state.track('adopted-one', { supervision: 'adopted', baseSequence: 7 });
    state.track('released-one', { supervision: 'adopted' });
    state.track('released-one', { supervision: 'released' });
    assert.deepEqual(state.listSupervised().map((entry) => [entry.sessionId, entry.supervision]).sort(), [['adopted-one', 'adopted'], ['started-one', 'started']]);
    assert.equal(newService().get('adopted-one')?.baseSequence, 7);
  });
});

test('a database from before sandboxes and hand-over is migrated: old guards are dropped and no old row is supervised', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'foreman-state-old-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    db.exec('DROP TABLE foreman_session_state');
    db.exec("CREATE TABLE foreman_session_state (session_id TEXT PRIMARY KEY NOT NULL, task_id TEXT, status TEXT NOT NULL DEFAULT 'idle', permission_mode TEXT, billing TEXT, guard_json TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.prepare("INSERT INTO foreman_session_state (session_id, guard_json) VALUES ('old-one', '{\"enabled\":true}')").run();
    closeConnection();
    await initializeDatabase();
    const row = foremanSessionStateDb.get('old-one');
    assert.equal(row?.sandbox_json, null);
    assert.equal(row?.supervision, 'released');
    assert.equal(row?.base_sequence, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

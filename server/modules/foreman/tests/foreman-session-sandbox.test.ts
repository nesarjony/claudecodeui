import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanSessionStateService, type ForemanSessionStateStore } from '@/modules/foreman/foreman-session-state.service.js';

import { SAMPLE_SCOPE, samplePolicy, sampleSandbox } from './foreman-sandbox-support.js';

type StateRow = Parameters<ForemanSessionStateStore['upsert']>[0];

/** A state store over a map whose reads and writes a test can make fail. */
function memoryStore() {
  const rows = new Map<string, StateRow>();
  const faults = { read: null as Error | null, write: null as Error | null };
  const store: ForemanSessionStateStore = {
    get: (id) => {
      if (faults.read) throw faults.read;
      return rows.get(id) ?? null;
    },
    upsert: (row) => {
      if (faults.write) throw faults.write;
      rows.set(row.session_id, { ...row });
    },
    updateStatus: () => true,
    settleAfterRestart: () => ({ reset: 0, waitingPermission: 0 }),
    listSupervised: () => [],
  };
  return { rows, faults, store };
}

test('trackStrict throws when the write fails and leaves nothing behind, in memory or in the store', () => {
  const { rows, faults, store } = memoryStore();
  const state = createForemanSessionStateService({ store });
  faults.write = new Error('disk I/O error');
  assert.throws(() => state.trackStrict('s1', { permissionMode: 'default', sandbox: sampleSandbox() }), /disk I\/O error/);
  assert.equal(state.get('s1'), null, 'memory did not move ahead of the store');
  assert.equal(rows.size, 0);

  faults.write = null;
  state.trackStrict('s1', { permissionMode: 'default', sandbox: sampleSandbox() });
  assert.equal(rows.get('s1')?.sandbox_json, JSON.stringify(samplePolicy()));
  assert.deepEqual(state.sandboxOf('s1'), { policy: samplePolicy() });
});

test('a later lenient track keeps the sandbox a strict one recorded', () => {
  const { rows, store } = memoryStore();
  const state = createForemanSessionStateService({ store });
  state.trackStrict('s1', { sandbox: sampleSandbox() });
  state.track('s1', { permissionMode: 'plan' });
  assert.equal(rows.get('s1')?.sandbox_json, JSON.stringify(samplePolicy()));
  assert.equal(rows.get('s1')?.permission_mode, 'plan');
});

// ---------------------------------------------------------------------------------------------
// sandboxOf: fail closed for Foreman's runs (marked `required`), never refuse the owner's for an unreadable table
// ---------------------------------------------------------------------------------------------

const MARKED = { required: true };
const UNMARKED = { required: false };
const storedRow = (sessionId: string, sandboxJson: string | null): StateRow => ({
  session_id: sessionId, task_id: null, status: 'idle', permission_mode: null, billing: null, sandbox_json: sandboxJson,
  supervision: sandboxJson ? 'started' : 'adopted', base_head: null, base_sequence: 0, updated_at: '2026-11-14T08:00:00.000Z',
  sandbox_scope_json: sandboxJson ? JSON.stringify(SAMPLE_SCOPE) : null,
});
const refuses = (answer: unknown, pattern: RegExp) => assert.match((answer as { refuse: string }).refuse, pattern);

test('the read works and a policy is stored: it applies to every run, marked or not', () => {
  const { rows, store } = memoryStore();
  rows.set('worker', storedRow('worker', JSON.stringify(samplePolicy())));
  const state = createForemanSessionStateService({ store });
  assert.deepEqual(state.sandboxOf('worker', MARKED), { policy: samplePolicy() });
  assert.deepEqual(state.sandboxOf('worker', UNMARKED), { policy: samplePolicy() });
  assert.deepEqual(state.sandboxOf('worker'), { policy: samplePolicy() }, 'unmarked is the default');
});

test('the read works and no policy is stored: a marked run is refused, an unmarked one runs as before', () => {
  const { rows, store } = memoryStore();
  rows.set('adopted', storedRow('adopted', null));
  const state = createForemanSessionStateService({ store });
  for (const sessionId of ['adopted', 'never-seen']) {
    refuses(state.sandboxOf(sessionId, MARKED), /no sandbox is stored for it, so it does not run/);
    assert.equal(state.sandboxOf(sessionId, UNMARKED), null, sessionId);
  }
});

test('the read fails: a policy read or written earlier in this process applies to every run', () => {
  const { rows, faults, store } = memoryStore();
  rows.set('read-before', storedRow('read-before', JSON.stringify(samplePolicy())));
  const log: string[] = [];
  const state = createForemanSessionStateService({ store, log: (message) => log.push(message) });
  assert.deepEqual(state.sandboxOf('read-before'), { policy: samplePolicy() });
  const written = samplePolicy({ scratchDir: '/mnt/dev/scratch/written' });
  state.trackStrict('written-before', { sandbox: { policy: written, scope: SAMPLE_SCOPE } });

  faults.read = new Error('database disk image is malformed');
  for (const run of [MARKED, UNMARKED]) {
    assert.deepEqual(state.sandboxOf('read-before', run), { policy: samplePolicy() });
    assert.deepEqual(state.sandboxOf('written-before', run), { policy: written });
  }
  assert.deepEqual(log, [], 'nothing to report: the remembered policy applied');
});

test('the read fails and nothing is remembered: a marked run is refused, the owner\'s session runs as before', () => {
  const { rows, faults, store } = memoryStore();
  rows.set('worker', storedRow('worker', JSON.stringify(samplePolicy())));
  const log: string[] = [];
  const state = createForemanSessionStateService({ store, log: (message) => log.push(message) });
  faults.read = new Error('database is locked');
  refuses(state.sandboxOf('worker', MARKED), /could not be read \(database is locked\), so it does not run/);
  assert.equal(state.sandboxOf('owner', UNMARKED), null, 'an unreadable table never stops an owner\'s session');
  assert.ok(log.every((message) => /sandbox of session \S+ not read: database is locked/.test(message)) && log.length === 2);
});

test('a stored policy that is malformed or no longer allowed refuses every run, even with a good one remembered', () => {
  const { rows, store } = memoryStore();
  const state = createForemanSessionStateService({ store });
  state.trackStrict('worker', { sandbox: sampleSandbox() });
  const tooWide = { ...samplePolicy(), env: { NODE_OPTIONS: '--inspect' } };
  for (const broken of ['{not json', JSON.stringify({ scratchDir: '/x' }), JSON.stringify(tooWide)]) {
    rows.set('worker', storedRow('worker', broken));
    for (const run of [MARKED, UNMARKED]) {
      refuses(state.sandboxOf('worker', run), /malformed or no longer allowed, so it does not run/);
    }
  }
});

test('a stored policy is checked against the scope stored with it: without one, or writing outside it, it refuses every run', () => {
  const { rows, store } = memoryStore();
  const state = createForemanSessionStateService({ store });
  rows.set('unscoped', { ...storedRow('unscoped', JSON.stringify(samplePolicy())), sandbox_scope_json: null });
  const outside = samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowWrite: ['/mnt/dev/other-project'] } });
  rows.set('outside', storedRow('outside', JSON.stringify(outside)));
  rows.set('inside', storedRow('inside', JSON.stringify(samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowWrite: ['/mnt/dev/repo/src'] } }))));
  for (const run of [MARKED, UNMARKED]) {
    refuses(state.sandboxOf('unscoped', run), /malformed or no longer allowed/);
    refuses(state.sandboxOf('outside', run), /malformed or no longer allowed/);
    assert.ok('policy' in (state.sandboxOf('inside', run) ?? {}), 'a write inside the stored project is allowed');
  }
});

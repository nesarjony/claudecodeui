import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanSessionStateService, type ForemanSessionStateStore } from '@/modules/foreman/foreman-session-state.service.js';

import { samplePolicy } from './foreman-sandbox-support.js';

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
  assert.throws(() => state.trackStrict('s1', { permissionMode: 'default', sandbox: samplePolicy() }), /disk I\/O error/);
  assert.equal(state.get('s1'), null, 'memory did not move ahead of the store');
  assert.equal(rows.size, 0);

  faults.write = null;
  state.trackStrict('s1', { permissionMode: 'default', sandbox: samplePolicy() });
  assert.equal(rows.get('s1')?.sandbox_json, JSON.stringify(samplePolicy()));
  assert.deepEqual(state.sandboxOf('s1'), { policy: samplePolicy() });
});

test('a later lenient track keeps the sandbox a strict one recorded', () => {
  const { rows, store } = memoryStore();
  const state = createForemanSessionStateService({ store });
  state.trackStrict('s1', { sandbox: samplePolicy() });
  state.track('s1', { permissionMode: 'plan' });
  assert.equal(rows.get('s1')?.sandbox_json, JSON.stringify(samplePolicy()));
  assert.equal(rows.get('s1')?.permission_mode, 'plan');
});

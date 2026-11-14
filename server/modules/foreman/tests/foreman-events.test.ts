import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyModelBilling,
  createRuntimeOutcomeTracker,
  declaredModelBilling,
  splitModelBilling,
} from '@/modules/foreman/foreman-events.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import type { ClaudeRuntimeEvent, ForemanBilling } from '@/shared/types.js';

type TurnResultEvent = Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;

const base = { sessionId: 'sess-1', projectPath: '/mnt/dev/repo' };

function turnResult(overrides: Partial<TurnResultEvent> & { message?: Record<string, unknown> } = {}): TurnResultEvent {
  return { ...base, kind: 'turn_result', message: { subtype: 'success', is_error: false, ...overrides.message }, model: null, toolCalls: 0, toolErrors: 0 };
}

test('billing helpers read and apply the @api marker', () => {
  assert.deepEqual(splitModelBilling('sonnet@api'), { model: 'sonnet', billing: 'api-key' });
  assert.deepEqual(splitModelBilling('claude-opus-5-5[1m]'), { model: 'claude-opus-5-5[1m]', billing: 'subscription' });
  assert.deepEqual(splitModelBilling(null), { model: null, billing: 'subscription' });
  assert.equal(applyModelBilling('sonnet', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@api', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@api', 'subscription'), 'sonnet');
});

test('billing helpers read and apply the @cap marker, and a model never carries two markers', () => {
  assert.deepEqual(splitModelBilling('claude-sonnet-5-5@cap'), { model: 'claude-sonnet-5-5', billing: 'cap' });
  assert.deepEqual(splitModelBilling('claude-opus-5-5[1m]@cap'), { model: 'claude-opus-5-5[1m]', billing: 'cap' });
  assert.deepEqual(splitModelBilling('  sonnet@cap  '), { model: 'sonnet', billing: 'cap' });
  assert.equal(applyModelBilling('sonnet', 'cap'), 'sonnet@cap');
  assert.equal(applyModelBilling('sonnet@cap', 'cap'), 'sonnet@cap');
  // Switching the billing replaces the marker instead of stacking a second one.
  assert.equal(applyModelBilling('sonnet@api', 'cap'), 'sonnet@cap');
  assert.equal(applyModelBilling('sonnet@cap', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@cap', 'subscription'), 'sonnet');
  // A value that somehow carries both: the outermost marker decides, every marker is removed.
  assert.deepEqual(splitModelBilling('sonnet@api@cap'), { model: 'sonnet', billing: 'cap' });
  assert.deepEqual(splitModelBilling('sonnet@cap@api'), { model: 'sonnet', billing: 'api-key' });
  // A marker alone is no model.
  assert.deepEqual(splitModelBilling('@cap'), { model: null, billing: 'cap' });
});

test('every billing survives marker and split round trips (plain model, [1m] form, repeated application, model switch)', () => {
  const billings: ForemanBilling[] = ['api-key', 'subscription', 'cap'];
  for (const model of ['default', 'sonnet', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'haiku']) {
    for (const billing of billings) {
      const marked = applyModelBilling(model, billing);
      assert.deepEqual(splitModelBilling(marked), { model, billing }, `${model} ${billing}`);
      assert.equal(applyModelBilling(marked, billing), marked, `${model} ${billing} idempotent`);
      // A model switch (what POST /model stores): the new plain model gets the session's billing back.
      const switched = applyModelBilling('claude-opus-5-5', splitModelBilling(marked).billing);
      assert.deepEqual(splitModelBilling(switched), { model: 'claude-opus-5-5', billing }, `${model} ${billing} switch`);
    }
  }
});

test('declaredModelBilling reads the marker only: a plain model declares nothing', () => {
  assert.equal(declaredModelBilling('sonnet@cap'), 'cap');
  assert.equal(declaredModelBilling('sonnet@api'), 'api-key');
  assert.equal(declaredModelBilling('sonnet'), null);
  assert.equal(declaredModelBilling(''), null);
  assert.equal(declaredModelBilling(null), null);
});

// The runtime strips the same literals (claude-runtime-events.test.ts drives `@api` and `@cap` runs through the real runtime).
test('the markers the bridge writes are @api for api-key and @cap for cap', () => {
  assert.equal(applyModelBilling('x', 'api-key'), 'x@api');
  assert.equal(applyModelBilling('x', 'cap'), 'x@cap');
  assert.equal(applyModelBilling('x', 'subscription'), 'x');
});


test('the outcome tracker marks a failed session until it runs again', () => {
  const outcomes = createRuntimeOutcomeTracker();
  assert.equal(outcomes.hasFailed('sess-1'), false);
  outcomes.observe({ ...base, kind: 'run_error', message: 'boom' });
  assert.equal(outcomes.hasFailed('sess-1'), true);
  outcomes.observe({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null });
  assert.equal(outcomes.hasFailed('sess-1'), false);
  outcomes.observe(turnResult({ message: { is_error: true, subtype: 'error_max_turns' } }));
  assert.equal(outcomes.hasFailed('sess-1'), true);
  outcomes.observe(turnResult());
  assert.equal(outcomes.hasFailed('sess-1'), false);
});

// ---------------------------------------------------------------------------------------------
// Task links
// ---------------------------------------------------------------------------------------------

test('the task link is kept in memory and persisted so it survives a restart', () => {
  const persisted = new Map<string, string>();
  const backing = { get: (key: string) => persisted.get(key) ?? null, set: (key: string, value: string) => void persisted.set(key, value) };

  const first = createTaskIdStore(backing);
  assert.equal(first.get('sess-1'), null);
  first.set('sess-1', 'task-7');
  assert.equal(first.get('sess-1'), 'task-7');
  assert.equal(persisted.size, 1);

  // A fresh store (a restarted process) reads it back from the backing store.
  assert.equal(createTaskIdStore(backing).get('sess-1'), 'task-7');
});

test('a failing backing store never breaks the task link', () => {
  const store = createTaskIdStore({
    get: () => { throw new Error('db closed'); },
    set: () => { throw new Error('db closed'); },
  });
  store.set('sess-1', 'task-7');
  assert.equal(store.get('sess-1'), 'task-7');
  assert.equal(store.get('other'), null);
});

// ---------------------------------------------------------------------------------------------
// The pusher

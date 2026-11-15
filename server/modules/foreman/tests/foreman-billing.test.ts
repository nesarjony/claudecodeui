import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyModelBilling,
  declaredModelBilling,
  splitModelBilling,
} from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanBilling } from '@/shared/types.js';

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

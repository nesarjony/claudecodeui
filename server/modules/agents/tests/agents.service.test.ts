import assert from 'node:assert/strict';
import test from 'node:test';

import { priceFor } from '@/modules/agents/agents.service.js';

// priceFor takes the first PRICES entry whose key the model id contains, so a minor release
// must be listed before the major it contains ('fable-5-2' before 'fable-5') or it is billed at
// the older, dearer rate.
test('Fable 5.2 and Mythos 5.2 are priced at their own rate, not the Fable 5 rate', () => {
  const fable52 = { input: 8, output: 40, cacheRead: 0.2 };
  assert.deepEqual(priceFor('claude-fable-5-2'), fable52);
  assert.deepEqual(priceFor('claude-mythos-5-2'), fable52);
  assert.deepEqual(priceFor('claude-fable-5-2[1m]'), fable52);
  assert.deepEqual(priceFor('Claude-Fable-5-2'), fable52);
});

test('Fable 5 and Fable 5.1 keep their own rates next to the 5.2 entries', () => {
  assert.deepEqual(priceFor('claude-fable-5'), { input: 10, output: 50, cacheRead: 1 });
  assert.deepEqual(priceFor('claude-fable-5-1'), { input: 10, output: 50, cacheRead: 0.25 });
  assert.deepEqual(priceFor('claude-mythos-5-1'), { input: 10, output: 50, cacheRead: 0.25 });
});

test('a model with no listed price has none', () => {
  assert.equal(priceFor(null), null);
  assert.equal(priceFor('deepseek-v4'), null);
});

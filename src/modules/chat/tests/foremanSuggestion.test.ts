import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  DEFAULT_CONTINUE_TEXT,
  confidencePercent,
  foremanModelLabel,
  foremanModelToCloudcli,
  isExecutableAction,
  isForemanSuggestion,
  planSuggestion,
  type ForemanDecision,
  type ForemanSuggestion,
} from '@/modules/chat/foreman/foremanSuggestion';

const suggestion = (decision: Partial<ForemanDecision>, over: Partial<ForemanSuggestion['decision']> = {}): ForemanSuggestion => ({
  id: 'sug_1',
  sessionId: 'session-1',
  status: 'pending',
  decision: {
    decision: { reason: 'because', action: 'continue', confidence: 0.9, risk: 'low', ...decision },
    model: 'api-haiku',
    ...over,
  },
});

const plan = (decision: Partial<ForemanDecision>, currentModel: string | null = 'sonnet') =>
  planSuggestion(suggestion(decision), { currentModel });

// --- the action mapping ------------------------------------------------------------------------

test('steer, answer and demand_evidence send their message', () => {
  for (const action of ['steer', 'answer', 'demand_evidence'] as const) {
    assert.deepEqual(plan({ action, message: '  Stay on the task.  ' }), { kind: 'send', text: 'Stay on the task.' }, action);
  }
});

test('continue sends its message, or "Please continue." when it has none', () => {
  assert.deepEqual(plan({ action: 'continue', message: 'Keep going with the tests.' }), { kind: 'send', text: 'Keep going with the tests.' });
  assert.deepEqual(plan({ action: 'continue' }), { kind: 'send', text: DEFAULT_CONTINUE_TEXT });
  assert.deepEqual(plan({ action: 'continue', message: '   ' }), { kind: 'send', text: DEFAULT_CONTINUE_TEXT });
});

test('a send action with no message falls back to information (nothing to press Send on)', () => {
  assert.deepEqual(plan({ action: 'steer', reason: 'off track' }), { kind: 'info', text: 'off track', unavailable: false });
});

test('compact sends /compact with the instructions', () => {
  assert.deepEqual(plan({ action: 'compact', instructions: 'keep the task notes' }), { kind: 'send', text: '/compact keep the task notes' });
  assert.deepEqual(plan({ action: 'compact' }), { kind: 'send', text: '/compact' });
});

test('switch_model offers the switch through the existing model path, unless the session is already on it', () => {
  assert.deepEqual(plan({ action: 'switch_model', model: 'api-opus' }, 'sonnet'), { kind: 'switch_model', alias: 'api-opus', model: 'opus' });
  assert.deepEqual(plan({ action: 'switch_model', model: 'api-opus' }, 'claude-opus-5-5'), { kind: 'info', text: 'because', unavailable: false });
  assert.deepEqual(plan({ action: 'switch_model' }, 'sonnet'), { kind: 'info', text: 'because', unavailable: false });
});

test('needs_user shows the question, falling back to the reason; stop shows the reason', () => {
  assert.deepEqual(plan({ action: 'needs_user', question: 'Drop the table?' }), { kind: 'info', text: 'Drop the table?', unavailable: false });
  assert.deepEqual(plan({ action: 'needs_user' }), { kind: 'info', text: 'because', unavailable: false });
  assert.deepEqual(plan({ action: 'stop', reason: 'work is verified' }), { kind: 'info', text: 'work is verified', unavailable: false });
});

test('write_notes and handoff are executable: a button that has Foreman do it, with the reason as the text', () => {
  assert.deepEqual(plan({ action: 'write_notes', reason: 'Rule notes_due: context 41% >= notes_at 35%' }), { kind: 'execute', action: 'write_notes', text: 'Rule notes_due: context 41% >= notes_at 35%' });
  assert.deepEqual(plan({ action: 'handoff', reason: 'Context at 84%' }), { kind: 'execute', action: 'handoff', text: 'Context at 84%' });
  assert.equal(isExecutableAction('handoff'), true);
  assert.equal(isExecutableAction('write_notes'), true);
  assert.equal(isExecutableAction('compact'), false);
});

test('delegate, split and run_judge are information only, marked not available yet', () => {
  for (const action of ['delegate', 'split', 'run_judge'] as const) {
    const result = plan({ action, reason: 'worth a judge' });
    assert.equal(result.kind, 'info', action);
    assert.equal(result.kind === 'info' && result.unavailable, true, action);
  }
  assert.deepEqual(plan({ action: 'delegate', instructions: 'look into the flaky test', reason: 'r' }), {
    kind: 'info',
    text: 'look into the flaky test',
    unavailable: true,
  });
});

// --- model aliases -----------------------------------------------------------------------------

test('Foreman aliases map to cloudcli model families and keep API-key billing', () => {
  assert.equal(foremanModelToCloudcli('api-opus', 'sonnet'), 'opus');
  assert.equal(foremanModelToCloudcli('api-haiku', 'sonnet@api'), 'haiku@api');
  assert.equal(foremanModelToCloudcli('api-sonnet', 'claude-opus-5-5[1m]@api'), 'sonnet@api');
  assert.equal(foremanModelToCloudcli('api-sonnet', null), 'sonnet');
});

test('no switch when the session is already on that model, or the alias is unknown', () => {
  assert.equal(foremanModelToCloudcli('api-sonnet', 'sonnet'), null);
  assert.equal(foremanModelToCloudcli('api-sonnet', 'claude-sonnet-5-5@api'), null);
  assert.equal(foremanModelToCloudcli('api-nonsense', 'sonnet'), null);
  assert.equal(foremanModelToCloudcli(undefined, 'sonnet'), null);
});

test('labels and percentages', () => {
  assert.equal(foremanModelLabel('api-haiku'), 'Haiku');
  assert.equal(foremanModelLabel('api-sonnet'), 'Sonnet');
  assert.equal(confidencePercent(0.924), 92);
  assert.equal(confidencePercent(1.4), 100);
  assert.equal(confidencePercent(-1), 0);
});

// --- validating frames -------------------------------------------------------------------------

test('isForemanSuggestion accepts a well-formed suggestion and rejects anything else', () => {
  assert.equal(isForemanSuggestion(suggestion({ action: 'steer', message: 'x' })), true);
  for (const bad of [
    null,
    'x',
    {},
    { ...suggestion({}), status: 'done' },
    { ...suggestion({}), id: 7 },
    { ...suggestion({}), decision: { model: 'api-haiku' } },
    suggestion({ action: 'fly' as never }),
    suggestion({ risk: 'extreme' as never }),
    suggestion({ confidence: 'high' as never }),
  ]) {
    assert.equal(isForemanSuggestion(bad), false, JSON.stringify(bad));
  }
});

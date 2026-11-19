import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_API_KEY_MODEL_SUFFIX,
  CLAUDE_CAP_MODEL_SUFFIX,
  CLAUDE_PREDEFINED_MODELS,
  extractClaudeEventModel,
  findClaudeModelOption,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('the catalog lists a cap variant of every model that has an API-key variant, with the same effort choices', () => {
  const values = new Set(CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value));
  const apiVariants = CLAUDE_PREDEFINED_MODELS.OPTIONS.filter((option) => option.value.endsWith(CLAUDE_API_KEY_MODEL_SUFFIX));
  assert.ok(apiVariants.length > 0);
  for (const option of apiVariants) {
    const plain = option.value.slice(0, -CLAUDE_API_KEY_MODEL_SUFFIX.length);
    const capValue = `${plain}${CLAUDE_CAP_MODEL_SUFFIX}`;
    assert.ok(values.has(capValue), capValue);
    assert.deepEqual(findClaudeModelOption(capValue)?.effort, option.effort, capValue);
  }
  // 'best' has no marked variants (its target depends on the account), and no value carries two markers.
  assert.equal(values.has(`best${CLAUDE_CAP_MODEL_SUFFIX}`), false);
  assert.equal(values.size, CLAUDE_PREDEFINED_MODELS.OPTIONS.length, 'values are unique');
  assert.equal([...values].some((value) => /@(api|cap).*@(api|cap)/.test(value)), false);
  assert.match(findClaudeModelOption('claude-sonnet-5-5@cap')?.label ?? '', /claude-cap profile/);
});

test('Fable 5.2 is listed by its explicit id with ultracode, has no 1M variant, and its marked variants read cleanly', () => {
  const fable52 = findClaudeModelOption('claude-fable-5-2');
  assert.equal(fable52?.label, 'Fable 5.2');
  assert.equal(fable52?.effort?.default, 'high');
  assert.deepEqual(
    fable52?.effort?.values.map((entry) => entry.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  );
  assert.deepEqual(fable52?.effort, findClaudeModelOption('fable')?.effort);
  // The alias keeps its own label; Fable has the 1M window natively, so there is no [1m] entry.
  assert.equal(findClaudeModelOption('fable')?.label, 'Fable 5');
  assert.equal(findClaudeModelOption('claude-fable-5-2[1m]'), null);

  // The marked variants are generated from the base entry, whose description ends in a full stop so the suffix sentence reads on.
  assert.ok(fable52?.description?.endsWith('.'));
  const apiVariant = findClaudeModelOption(`claude-fable-5-2${CLAUDE_API_KEY_MODEL_SUFFIX}`);
  assert.equal(apiVariant?.label, 'Fable 5.2 · API key');
  assert.match(apiVariant?.description ?? '', /tasks\. Billed to the Anthropic API key\.$/);
  assert.equal(findClaudeModelOption(`claude-fable-5-2${CLAUDE_CAP_MODEL_SUFFIX}`)?.label, 'Fable 5.2 · claude-cap profile');
});

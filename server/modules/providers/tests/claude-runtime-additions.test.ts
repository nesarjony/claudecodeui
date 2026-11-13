import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRuntimeModelAndToolAdditions,
  removeRememberedDenial,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

type Options = { fallbackModel?: string; disallowedTools?: string[]; model?: string };

test('the fallback model is set on the SDK options, trimmed, and an empty one is not', () => {
  const options: Options = { model: 'claude-opus-5-5' };
  assert.deepEqual(applyRuntimeModelAndToolAdditions(options, { fallbackModel: ' claude-sonnet-5-5 ' }), []);
  assert.equal(options.fallbackModel, 'claude-sonnet-5-5');

  for (const fallbackModel of [undefined, '', '   ', 7 as unknown as string]) {
    const untouched: Options = {};
    applyRuntimeModelAndToolAdditions(untouched, { fallbackModel });
    assert.equal('fallbackModel' in untouched, false, String(fallbackModel));
  }
});

test('denied tools join the run\'s own disallowed tools: deduplicated, every existing entry kept, order kept', () => {
  const options: Options = { disallowedTools: ['Bash(rm:*)', 'mcp__a__b'] };
  const enforced = applyRuntimeModelAndToolAdditions(options, { disallowedTools: ['mcp__a__b', 'mcp__infigraph__save_session', 'mcp__infigraph__save_session', 'WebFetch'] });
  assert.deepEqual(options.disallowedTools, ['Bash(rm:*)', 'mcp__a__b', 'mcp__infigraph__save_session', 'WebFetch']);
  // Everything Foreman denied is protected, including the entry the run already had.
  assert.deepEqual(enforced, ['mcp__a__b', 'mcp__infigraph__save_session', 'WebFetch']);
});

test('denied tools reach options that had none, and unusable entries are ignored', () => {
  const options: Options = {};
  const enforced = applyRuntimeModelAndToolAdditions(options, { disallowedTools: ['mcp__x__y', '', '  ', 3 as unknown as string] });
  assert.deepEqual(options.disallowedTools, ['mcp__x__y']);
  assert.deepEqual(enforced, ['mcp__x__y']);
});

test('no additions leave the options alone (and do not create an empty list)', () => {
  const options: Options = { disallowedTools: ['Bash'], model: 'm' };
  assert.deepEqual(applyRuntimeModelAndToolAdditions(options, {}), []);
  assert.deepEqual(options, { disallowedTools: ['Bash'], model: 'm' });

  const bare: Options = {};
  assert.deepEqual(applyRuntimeModelAndToolAdditions(bare, { disallowedTools: [] }), []);
  assert.deepEqual(bare, {});

  assert.deepEqual(applyRuntimeModelAndToolAdditions(bare, { disallowedTools: 'Bash' as unknown as string[] }), []);
  assert.deepEqual(bare, {});
});

test('an "always allow" removes the tool from the disallowed list, unless Foreman denied it', () => {
  const disallowed = ['Bash(rm:*)', 'mcp__infigraph__save_session', 'WebFetch'];
  const enforced = ['mcp__infigraph__save_session'];
  // The person's own denial of WebFetch is undone, as before.
  assert.deepEqual(removeRememberedDenial(disallowed, 'WebFetch', enforced), ['Bash(rm:*)', 'mcp__infigraph__save_session']);
  // Foreman's is not.
  assert.deepEqual(removeRememberedDenial(disallowed, 'mcp__infigraph__save_session', enforced), disallowed);
  // With nothing enforced it behaves exactly like the old filter.
  assert.deepEqual(removeRememberedDenial(disallowed, 'mcp__infigraph__save_session', []), ['Bash(rm:*)', 'WebFetch']);
  // An entry that is not denied changes nothing.
  assert.deepEqual(removeRememberedDenial(disallowed, 'Read', enforced), disallowed);
});

test('a Foreman denial that duplicated a user denial survives that user\'s "always allow"', () => {
  const options: Options = { disallowedTools: ['mcp__a__b'] };
  const enforced = applyRuntimeModelAndToolAdditions(options, { disallowedTools: ['mcp__a__b'] });
  assert.deepEqual(removeRememberedDenial(options.disallowedTools!, 'mcp__a__b', enforced), ['mcp__a__b']);
});

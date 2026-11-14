import assert from 'node:assert/strict';
import test from 'node:test';

import { isErrorTurnResult } from '@/shared/utils.js';

test('a turn result is an error by its flag or by an error subtype, whichever the CLI used', () => {
  assert.equal(isErrorTurnResult({ is_error: true }), true);
  assert.equal(isErrorTurnResult({ is_error: true, subtype: 'success' }), true, 'the CLI can report a failure under subtype success');
  assert.equal(isErrorTurnResult({ subtype: 'error_max_turns' }), true);
  assert.equal(isErrorTurnResult({ subtype: 'error_during_execution', is_error: false }), true);
});

test('a clean turn result, or one of an unexpected shape, is not an error', () => {
  assert.equal(isErrorTurnResult({ subtype: 'success', is_error: false }), false);
  assert.equal(isErrorTurnResult({}), false);
  assert.equal(isErrorTurnResult({ is_error: 'true' }), false, 'only the boolean flag counts');
  assert.equal(isErrorTurnResult({ subtype: 42 }), false);
  assert.equal(isErrorTurnResult({ subtype: null }), false);
});

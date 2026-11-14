import assert from 'node:assert/strict';
import test from 'node:test';

import { DONE_MARKER, translateRuntimeEvent } from '@/modules/foreman/foreman-event-translate.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

const base = { sessionId: 'sess-1', projectPath: '/mnt/dev/repo' };

const turnResult = (message: Record<string, unknown>): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message, model: 'MiniMax-M3', toolCalls: 3, toolErrors: 0 });

test('a successful turn is a turn_end with the final text, the commits the caller counted, the answering model and the usage', () => {
  const body = translateRuntimeEvent(
    turnResult({ subtype: 'success', is_error: false, result: 'Row 3 is committed.', usage: { input_tokens: 11, output_tokens: 222, cache_read_input_tokens: 3333 } }),
    { commitCount: 2 },
  );
  assert.deepEqual(body, {
    kind: 'turn_end',
    payload: { text: 'Row 3 is committed.', commitCount: 2, claimsDone: false, model: 'MiniMax-M3', usage: { inputTokens: 11, outputTokens: 222, cacheReadTokens: 3333, cacheCreationTokens: null } },
  });
});

test('a turn the runtime saw no model for reports the only model it billed, or none', () => {
  const modelOf = (event: ClaudeRuntimeEvent) => {
    const body = translateRuntimeEvent(event, { commitCount: 0 });
    return body?.kind === 'turn_end' ? body.payload.model : 'not a turn_end';
  };
  const unseen = (message: Record<string, unknown>): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message: { subtype: 'success', result: '', ...message }, model: null, toolCalls: 0, toolErrors: 0 });
  assert.equal(modelOf(unseen({ modelUsage: { 'MiniMax-M3': {} } })), 'MiniMax-M3');
  assert.equal(modelOf(unseen({ modelUsage: { 'MiniMax-M3': {}, other: {} } })), null);
  assert.equal(modelOf(unseen({})), null);
});

test('only a last line that is exactly the done marker claims the batch is done', () => {
  const claimsDone = (text: string): boolean => {
    const body = translateRuntimeEvent(turnResult({ subtype: 'success', result: text }), { commitCount: 0 });
    return body?.kind === 'turn_end' && body.payload.claimsDone;
  };
  assert.equal(claimsDone(`All rows are in.\n\n${DONE_MARKER}\n`), true);
  for (const text of [`${DONE_MARKER}\nbut one more thing`, `I will say ${DONE_MARKER} when I am done`, 'FOREMAN-RESULT: working', '']) {
    assert.equal(claimsDone(text), false, text);
  }
});

test('a long final text is clipped', () => {
  const body = translateRuntimeEvent(turnResult({ subtype: 'success', result: 'x'.repeat(50_000) }), { commitCount: 0 });
  assert.equal(body?.kind === 'turn_end' && body.payload.text.length < 9000, true);
});

test('a turn that failed is an error, not a turn_end', () => {
  const body = translateRuntimeEvent(turnResult({ subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }), { commitCount: 1 });
  assert.deepEqual(body, { kind: 'error', payload: { message: 'The turn ended with error_max_turns: too many turns' } });
});

test('a request the CLI gave up on after a 429 is a quota event, and says nothing about when to resume', () => {
  const body = translateRuntimeEvent({ ...base, kind: 'assistant_error', error: 'rate_limit', text: 'API Error: Request rejected (429) · Profile over its share.' }, { commitCount: 0 });
  assert.deepEqual(body, { kind: 'quota', payload: { message: 'API Error: Request rejected (429) · Profile over its share.' } });
  assert.deepEqual(translateRuntimeEvent({ ...base, kind: 'assistant_error', error: 'rate_limit', text: '' }, { commitCount: 0 }), { kind: 'quota', payload: { message: 'The worker was refused with a 429.' } });
});

test('any other class of request the CLI gave up on is left to the failed turn that follows', () => {
  for (const error of ['authentication_failed', 'billing_error', 'invalid_request', 'server_error', 'unknown']) {
    assert.equal(translateRuntimeEvent({ ...base, kind: 'assistant_error', error, text: 'API Error' }, { commitCount: 0 }), null, error);
  }
});

test('a permission prompt carries the tool and a one-line detail', () => {
  const body = translateRuntimeEvent({ ...base, kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: { command: 'npm install left-pad' }, sandboxed: true }, { commitCount: 0 });
  assert.deepEqual(body, { kind: 'permission_request', payload: { requestId: 'r1', tool: 'Bash', detail: 'npm install left-pad' } });
});

test('a refusal from a stop reason and one from a notice both become a refusal with the explanation', () => {
  const fromStop = translateRuntimeEvent({ ...base, kind: 'assistant_refusal', message: { message: { stop_details: { explanation: 'Declined by the classifier.' } } } }, { commitCount: 0 });
  assert.deepEqual(fromStop, { kind: 'refusal', payload: { text: 'Declined by the classifier.' } });
  const fromNotice = translateRuntimeEvent({ ...base, kind: 'system_message', message: { subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' } }, { commitCount: 0 });
  assert.deepEqual(fromNotice, { kind: 'refusal', payload: { text: 'The model refused the request (cyber).' } });
});

test('a run that fails reports the error, and how a run ends decides the session_end', () => {
  assert.deepEqual(translateRuntimeEvent({ ...base, kind: 'run_error', message: 'spawn failed' }, { commitCount: 0 }), { kind: 'error', payload: { message: 'spawn failed' } });
  assert.deepEqual(translateRuntimeEvent({ ...base, kind: 'run_ended', reason: 'aborted' }, { commitCount: 0 }), { kind: 'session_end', payload: { reason: 'stopped' } });
  assert.deepEqual(translateRuntimeEvent({ ...base, kind: 'run_ended', reason: 'error' }, { commitCount: 0 }), { kind: 'session_end', payload: { reason: 'crashed' } });
  assert.equal(translateRuntimeEvent({ ...base, kind: 'run_ended', reason: 'completed' }, { commitCount: 0 }), null);
});

test('events Foreman has no use for map to nothing', () => {
  for (const event of [
    { ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null },
    { ...base, kind: 'system_message', message: { subtype: 'compact_boundary' } },
    { ...base, kind: 'permission_resolved', requestId: 'r1' },
  ] satisfies ClaudeRuntimeEvent[]) {
    assert.equal(translateRuntimeEvent(event, { commitCount: 0 }), null, event.kind);
  }
});

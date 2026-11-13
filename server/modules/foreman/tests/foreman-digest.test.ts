import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSessionDigest,
  estimateContextFromTranscript,
  hasTurnStarts,
  locateTranscript,
  parseTranscriptLines,
  readTranscriptRows,
} from '@/modules/foreman/foreman-digest.service.js';

// ---------------------------------------------------------------------------------------------
// Fixture transcript, shaped like the rows Claude Code writes (compact JSON, one block per row).
// ---------------------------------------------------------------------------------------------

const line = (entry: unknown) => JSON.stringify(entry);
let tick = 0;
const at = () => new Date(Date.UTC(2026, 10, 12, 9, 0, tick++)).toISOString();

const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', timestamp: at(), message: { role: 'user', content: text }, ...extra });

const assistant = (
  id: string,
  content: unknown[],
  stopReason: string | null,
  usage: Record<string, number> = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 },
  extra: Record<string, unknown> = {},
) =>
  line({
    type: 'assistant',
    timestamp: at(),
    message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content, stop_reason: stopReason, usage, ...extra },
  });

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (value: string) => ({ type: 'text', text: value });

const toolResult = (toolUseId: string, content: string, isError = false, extra: Record<string, unknown> = {}) =>
  line({
    type: 'user',
    timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    ...extra,
  });

function fixtureLines(): string[] {
  tick = 0;
  return [
    // --- turn 1 (older) ---
    user('Please look at src/a.ts'),
    assistant('msg_1', [toolUse('tu_read', 'Read', { file_path: '/repo/src/a.ts' })], 'tool_use'),
    toolResult('tu_read', 'file contents'),
    assistant('msg_2', [text('I read the file; it is fine.')], 'end_turn'),

    // --- turn 2 (the one under test) ---
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: 'ignored' }),
    user('Now run the tests and fix what breaks.'),
    assistant('msg_3', [toolUse('tu_todo', 'TodoWrite', {
      todos: [
        { content: 'Run tests', status: 'completed', activeForm: 'Running tests' },
        { content: 'Fix failures', status: 'in_progress', activeForm: 'Fixing failures' },
      ],
    })], 'tool_use'),
    toolResult('tu_todo', 'Todos modified'),
    // The Bash call fails: a tool error.
    assistant('msg_4', [toolUse('tu_bash', 'Bash', { command: 'pnpm test --filter api\n  --reporter=dot', description: 'Run tests' })], 'tool_use'),
    toolResult('tu_bash', 'Exit code 1\n2 tests failed', true),
    // One API response written as two rows (text block, then tool_use block) with the same id.
    assistant('msg_5', [text('Two tests failed; patching the handler.')], null),
    assistant('msg_5', [toolUse('tu_edit', 'Edit', { file_path: '/repo/src/handler.ts', old_string: 'a', new_string: 'b' })], 'tool_use'),
    toolResult('tu_edit', 'edited'),
    // A write that is rejected must not count as an edited file.
    assistant('msg_6', [toolUse('tu_write', 'Write', { file_path: '/repo/src/denied.ts', content: 'x' })], 'tool_use'),
    toolResult('tu_write', 'Permission denied', true),
    // Compaction happens mid-turn.
    line({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at(),
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 310000, postTokens: 15000, durationMs: 90000 },
    }),
    line({ type: 'user', isCompactSummary: true, timestamp: at(), message: { role: 'user', content: 'This session is being continued...' } }),
    // The model refuses once; the CLI reports it structurally as well.
    assistant('msg_7', [text('')], 'refusal', { input_tokens: 2, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 7 }, {
      stop_details: { type: 'refusal', category: 'reasoning_extraction', explanation: 'This request was blocked.' },
    }),
    line({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      timestamp: at(),
      apiRefusalCategory: 'reasoning_extraction',
      apiRefusalExplanation: 'This request was blocked as it seems to violate the terms.',
    }),
    line({ type: 'system', subtype: 'api_error', timestamp: at(), level: 'error', error: { message: 'Connection error.' } }),
    // A local API-error placeholder is not a real response.
    line({ type: 'assistant', timestamp: at(), message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [text('API Error')], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } } }),
    // The final answer.
    assistant('msg_8', [text('All tests pass now; I changed handler.ts.')], 'end_turn', {
      input_tokens: 5,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 500,
      output_tokens: 120,
    }),
    line({ type: 'cost-state', sessionId: 's', totalCostUSD: 1.2345, modelUsage: {} }),
  ];
}

// ---------------------------------------------------------------------------------------------

test('the digest of the last turn carries the user message, final text, tool calls, edits, todos and stop reason', () => {
  const digest = buildSessionDigest(parseTranscriptLines(fixtureLines().join('\n')), { turns: 1 });

  assert.equal(digest.turnsRequested, 1);
  assert.equal(digest.turnsIncluded, 1);
  assert.equal(digest.lastUserMessage, 'Now run the tests and fix what breaks.');
  assert.equal(digest.lastUserMessageKind, 'user');
  assert.equal(digest.finalAssistantText, 'All tests pass now; I changed handler.ts.');
  assert.equal(digest.stopReason, 'end_turn');

  // The first turn's Read call is outside the window.
  assert.deepEqual(
    digest.toolCalls.map((call) => [call.name, call.isError]),
    [['TodoWrite', false], ['Bash', true], ['Edit', false], ['Write', true]],
  );
  assert.equal(digest.toolCallCount, 4);
  assert.equal(digest.toolErrorCount, 2);
  assert.deepEqual(digest.toolCounts, { TodoWrite: 1, Bash: 1, Edit: 1, Write: 1 });

  // Short input: the command with whitespace collapsed (never multi-line).
  const bash = digest.toolCalls.find((call) => call.name === 'Bash');
  assert.equal(bash?.shortInput, 'pnpm test --filter api --reporter=dot');

  // Only the edit that succeeded counts as an edited file.
  assert.deepEqual(digest.filesEdited, ['/repo/src/handler.ts']);
  assert.equal(digest.filesEditedCount, 1);

  assert.deepEqual(digest.todos, [
    { content: 'Run tests', status: 'completed' },
    { content: 'Fix failures', status: 'in_progress' },
  ]);

  assert.equal(digest.turns.length, 1);
  assert.equal(digest.turns[0].toolCallCount, 4);
  assert.equal(digest.turns[0].assistantText, 'All tests pass now; I changed handler.ts.');
});

test('a refusal in the window is flagged with its category and explanation', () => {
  const digest = buildSessionDigest(parseTranscriptLines(fixtureLines().join('\n')), { turns: 1 });

  assert.equal(digest.refusal, true);
  assert.equal(digest.refusalDetail?.category, 'reasoning_extraction');
  assert.match(digest.refusalDetail?.explanation ?? '', /blocked/);

  const calm = buildSessionDigest(
    parseTranscriptLines([user('hi'), assistant('m', [text('hello')], 'end_turn')].join('\n')),
    { turns: 1 },
  );
  assert.equal(calm.refusal, false);
  assert.equal(calm.refusalDetail, null);
});

test('a refusal stop reason alone (no structured notice) is still detected', () => {
  const digest = buildSessionDigest(
    parseTranscriptLines([
      user('do the thing'),
      assistant('m', [text('')], 'refusal', undefined, { stop_details: { category: 'cyber', explanation: 'No.' } }),
    ].join('\n')),
    { turns: 1 },
  );
  assert.equal(digest.refusal, true);
  assert.equal(digest.stopReason, 'refusal');
  assert.deepEqual(digest.refusalDetail, { category: 'cyber', explanation: 'No.' });
});

test('compact boundaries, api errors, usage and reported cost are summarised', () => {
  const digest = buildSessionDigest(parseTranscriptLines(fixtureLines().join('\n')), { turns: 1 });

  assert.equal(digest.compactBoundaries.length, 1);
  assert.deepEqual(
    { ...digest.compactBoundaries[0], at: null },
    { at: null, trigger: 'auto', preTokens: 310000, postTokens: 15000 },
  );
  assert.equal(digest.apiErrorCount, 1);

  // msg_5's two rows count once; the synthetic API-error row is ignored entirely.
  assert.equal(digest.usage.outputTokens, 50 + 50 + 50 + 50 + 7 + 120);
  assert.equal(digest.usage.inputTokens, 10 + 10 + 10 + 10 + 2 + 5);
  assert.equal(digest.usage.cacheReadTokens, 1000 * 4 + 400 + 20000);
  assert.equal(digest.usage.contextTokens, 5 + 20000 + 500);
  assert.equal(digest.usage.costUsdReported, 1.2345);
});

test('asking for two turns widens the window and lists both', () => {
  const digest = buildSessionDigest(parseTranscriptLines(fixtureLines().join('\n')), { turns: 2 });

  assert.equal(digest.turnsIncluded, 2);
  assert.equal(digest.turns.length, 2);
  assert.equal(digest.turns[0].userMessage, 'Please look at src/a.ts');
  assert.equal(digest.turns[0].assistantText, 'I read the file; it is fine.');
  assert.equal(digest.turns[0].toolCallCount, 1);
  assert.equal(digest.turns[1].userMessage, 'Now run the tests and fix what breaks.');
  // The first turn's Read call is now inside the window.
  assert.equal(digest.toolCalls[0].name, 'Read');
  assert.equal(digest.toolCallCount, 5);
  // Asking for more turns than exist is not an error.
  assert.equal(buildSessionDigest(parseTranscriptLines(fixtureLines().join('\n')), { turns: 9 }).turnsIncluded, 2);
});

test('long text and long tool lists are capped', () => {
  const rows = [user('x'.repeat(10_000))];
  for (let i = 0; i < 100; i += 1) {
    rows.push(assistant(`m${i}`, [toolUse(`t${i}`, 'Bash', { command: `echo ${'z'.repeat(500)} ${i}` })], 'tool_use'));
  }
  rows.push(assistant('big', [text('y'.repeat(20_000))], 'end_turn'));
  const digest = buildSessionDigest(parseTranscriptLines(rows.join('\n')), { turns: 1 });

  assert.ok((digest.lastUserMessage ?? '').length <= 2000);
  assert.ok((digest.lastUserMessage ?? '').length > 1000, 'the clipped text keeps most of its budget');
  assert.ok((digest.finalAssistantText ?? '').length <= 4000);
  assert.match(digest.finalAssistantText ?? '', /chars clipped/);
  assert.equal(digest.toolCalls.length, 60);
  assert.equal(digest.toolCallCount, 100);
  assert.ok(digest.toolCalls.every((call) => call.shortInput.length <= 200));
});

test('a slash command echo is a turn start, shown as the command the sender typed', () => {
  const echo = '<command-name>/compact</command-name>\n  <command-message>compact</command-message>\n  <command-args>keep the notes</command-args>';
  const digest = buildSessionDigest(
    parseTranscriptLines([user('earlier work'), assistant('a', [text('ok')], 'end_turn'), user(echo)].join('\n')),
    { turns: 1 },
  );
  assert.equal(digest.lastUserMessage, '/compact keep the notes');
  assert.equal(digest.lastUserMessageKind, 'command');
});

test('background-task notifications are turns of their own kind', () => {
  const digest = buildSessionDigest(
    parseTranscriptLines([
      user('start the build'),
      assistant('a', [text('started')], 'end_turn'),
      user('<task-notification><task-id>b1</task-id></task-notification>', { origin: { kind: 'task-notification' } }),
      assistant('b', [text('the build finished')], 'end_turn'),
    ].join('\n')),
    { turns: 1 },
  );
  assert.equal(digest.lastUserMessageKind, 'task-notification');
  assert.equal(digest.finalAssistantText, 'the build finished');
});

test('subagent (sidechain) rows never leak into the main digest', () => {
  const digest = buildSessionDigest(
    parseTranscriptLines([
      user('delegate it'),
      line({ type: 'assistant', isSidechain: true, timestamp: at(), message: { id: 'sub', model: 'claude-sonnet-5-5', content: [toolUse('s1', 'Bash', { command: 'rm -rf x' })], stop_reason: 'tool_use' } }),
      assistant('main', [text('delegated')], 'end_turn'),
    ].join('\n')),
    { turns: 1 },
  );
  assert.equal(digest.toolCallCount, 0);
  assert.equal(digest.finalAssistantText, 'delegated');
});

test('the newer task tools (TaskCreate/TaskUpdate) are rebuilt into a todo list', () => {
  const created = (toolId: string, subject: string, taskId: string) => [
    assistant(`m_${toolId}`, [toolUse(toolId, 'TaskCreate', { subject, description: 'd' })], 'tool_use'),
    line({
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'created' }] },
      toolUseResult: { task: { id: taskId, subject } },
    }),
  ];
  const digest = buildSessionDigest(
    parseTranscriptLines([
      user('plan it'),
      ...created('c1', 'Write the schema', '1'),
      ...created('c2', 'Write the routes', '2'),
      assistant('u1', [toolUse('uu1', 'TaskUpdate', { taskId: '1', status: 'completed' })], 'tool_use'),
      assistant('u2', [toolUse('uu2', 'TaskUpdate', { taskId: '2', status: 'in_progress' })], 'tool_use'),
      assistant('end', [text('working')], 'end_turn'),
    ].join('\n')),
    { turns: 1 },
  );
  assert.deepEqual(digest.todos, [
    { content: 'Write the schema', status: 'completed' },
    { content: 'Write the routes', status: 'in_progress' },
  ]);
});

test('with no todo tool used the todo list is null', () => {
  const digest = buildSessionDigest(parseTranscriptLines([user('hi'), assistant('a', [text('yo')], 'end_turn')].join('\n')), { turns: 1 });
  assert.equal(digest.todos, null);
});

test('an empty transcript digests to nothing rather than failing', () => {
  const digest = buildSessionDigest([], { turns: 1 });
  assert.equal(digest.lastUserMessage, null);
  assert.equal(digest.finalAssistantText, null);
  assert.deepEqual(digest.toolCalls, []);
  assert.equal(digest.stopReason, null);
  assert.equal(digest.turnsIncluded, 0);
});

test('lines that are not whole JSON objects (a row still being written) are skipped', () => {
  const rows = parseTranscriptLines(`${user('hello')}\n\nnot json\n${'{"type":"assistant","mess'}`);
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Context estimate from transcript rows
// ---------------------------------------------------------------------------------------------

test('the context estimate is the last real request: prompt plus output tokens', () => {
  const rows = parseTranscriptLines([
    user('go'),
    assistant('a', [text('one')], 'end_turn', { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 10 }),
    assistant('b', [text('two')], 'end_turn', { input_tokens: 7, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, output_tokens: 300 }),
    line({ type: 'assistant', timestamp: at(), message: { id: 'syn', model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }),
  ].join('\n'));
  const estimate = estimateContextFromTranscript(rows);
  assert.equal(estimate?.usedTokens, 7 + 40000 + 2000 + 300);
  assert.equal(estimate?.basis, 'assistant_usage');
});

test('right after a compaction the estimate is the recorded post-compaction size', () => {
  const rows = parseTranscriptLines([
    user('go'),
    assistant('a', [text('one')], 'end_turn', { input_tokens: 5, cache_read_input_tokens: 900000, cache_creation_input_tokens: 0, output_tokens: 10 }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: at(), compactMetadata: { trigger: 'manual', preTokens: 900015, postTokens: 12345 } }),
  ].join('\n'));
  assert.deepEqual(
    { ...estimateContextFromTranscript(rows), at: null },
    { usedTokens: 12345, basis: 'compact_boundary', at: null },
  );
});

test('there is no estimate when no request has been recorded', () => {
  assert.equal(estimateContextFromTranscript(parseTranscriptLines(user('hello'))), null);
  assert.equal(estimateContextFromTranscript([]), null);
});

// ---------------------------------------------------------------------------------------------
// Reading real files
// ---------------------------------------------------------------------------------------------

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-digest-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a transcript file is read from its end, widening until enough turns are in view', async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, 'session.jsonl');
    // Turn 1, then ~1.5 MiB of unrelated rows, then turn 2: the first read (1 MiB) only sees turn 2.
    const filler = `${line({ type: 'attachment', timestamp: '2026-11-12T09:00:00.000Z', pad: 'p'.repeat(1000) })}\n`.repeat(1500);
    await writeFile(
      file,
      `${user('first request')}\n${assistant('a', [text('first answer')], 'end_turn')}\n${filler}${user('second request')}\n${assistant('b', [text('second answer')], 'end_turn')}\n${'{"type":"assistant","partial'}`,
    );

    const narrow = await readTranscriptRows(file, (rows) => hasTurnStarts(rows, 1));
    assert.equal(narrow?.truncatedHead, true);
    assert.equal(buildSessionDigest(narrow?.rows ?? [], { turns: 1, truncatedHead: true }).lastUserMessage, 'second request');

    const wide = await readTranscriptRows(file, (rows) => hasTurnStarts(rows, 2));
    const digest = buildSessionDigest(wide?.rows ?? [], { turns: 2, truncatedHead: wide?.truncatedHead });
    assert.equal(digest.turnsIncluded, 2);
    assert.equal(digest.turns[0].userMessage, 'first request');
    assert.equal(digest.transcriptTruncated, false);
  });
});

test('a cut-off transcript says so when fewer turns than requested were in reach', () => {
  const digest = buildSessionDigest(parseTranscriptLines(user('only turn in reach')), { turns: 3, truncatedHead: true });
  assert.equal(digest.transcriptTruncated, true);
});

test('an unreadable transcript yields null', async () => {
  assert.equal(await readTranscriptRows('/nonexistent/session.jsonl', () => true), null);
});

test('the transcript is found through its indexed path, or by provider id under the projects root', async () => {
  await withTempDirectory(async (directory) => {
    const projectsRoot = path.join(directory, 'projects');
    await mkdir(path.join(projectsRoot, '-mnt-dev-repo'), { recursive: true });
    const found = path.join(projectsRoot, '-mnt-dev-repo', 'prov-123.jsonl');
    await writeFile(found, user('hi'));
    const indexed = path.join(directory, 'indexed.jsonl');
    await writeFile(indexed, user('hi'));

    assert.equal(await locateTranscript({ jsonl_path: indexed, provider_session_id: 'x' }, projectsRoot), indexed);
    assert.equal(await locateTranscript({ jsonl_path: '/gone.jsonl', provider_session_id: 'prov-123' }, projectsRoot), found);
    assert.equal(await locateTranscript({ jsonl_path: null, provider_session_id: 'prov-123' }, projectsRoot), found);
    assert.equal(await locateTranscript({ jsonl_path: null, provider_session_id: 'missing' }, projectsRoot), null);
    assert.equal(await locateTranscript({ jsonl_path: null, provider_session_id: null }, projectsRoot), null);
    // A provider id that could climb out of the projects root is never used to build a path.
    assert.equal(await locateTranscript({ jsonl_path: null, provider_session_id: '../../etc/passwd' }, projectsRoot), null);
  });
});

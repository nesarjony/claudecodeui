import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  countTranscriptRowsAfter,
  describeStep,
  getStepsDurationMs,
  groupTranscriptSteps,
  isToolGroupItem,
  summarizeStepKinds,
} from '@/modules/chat/utils/toolGrouping';
import type { ChatMessage } from '@/shared/types';

/**
 * The transcript folds each run of consecutive tool calls into one "steps"
 * row. These pin what ends a run, what never folds, and the labels the row
 * shows for it.
 */

const toolMessage = (
  toolName: string,
  toolInput: unknown,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2024-01-01T00:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput),
  ...overrides,
});

const textMessage = (content: string, type = 'assistant'): ChatMessage => ({
  type,
  content,
  timestamp: '2024-01-01T00:00:00.000Z',
});

const thinkingMessage = (): ChatMessage => ({
  type: 'assistant',
  content: 'deliberating',
  timestamp: '2024-01-01T00:00:00.000Z',
  isThinking: true,
});

test('a run of different tools folds into one steps row', () => {
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Grep', { pattern: 'x' }),
    toolMessage('Bash', { command: 'ls' }),
  ]);

  assert.equal(items.length, 1);
  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.steps.length, 3);
});

test('a single tool call is still a steps row, so tool activity always looks the same', () => {
  const items = groupTranscriptSteps([toolMessage('Read', { file_path: '/a.ts' })]);

  assert.equal(items.length, 1);
  assert.ok(isToolGroupItem(items[0]));
});

test('assistant text and user turns end a run', () => {
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    textMessage('some prose'),
    toolMessage('Read', { file_path: '/b.ts' }),
    textMessage('next please', 'user'),
    toolMessage('Read', { file_path: '/c.ts' }),
  ]);

  assert.deepEqual(items.map((item) => (isToolGroupItem(item) ? 'steps' : item.type)), [
    'steps', 'assistant', 'steps', 'user', 'steps',
  ]);
});

test('an error row ends a run and stays outside it', () => {
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    { ...textMessage('rate limited'), type: 'error' },
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  assert.equal(items.length, 3);
  assert.equal((items[1] as ChatMessage).type, 'error');
});

test('questions and plan approvals are never folded away', () => {
  // They put a decision in front of the user; folding one would hide what the
  // agent is waiting on.
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('AskUserQuestion', { questions: [] }),
    toolMessage('Edit', { file_path: '/a.ts' }),
    toolMessage('ExitPlanMode', { plan: 'do it' }),
  ]);

  assert.deepEqual(items.map((item) => (isToolGroupItem(item) ? 'steps' : item.toolName)), [
    'steps', 'AskUserQuestion', 'steps', 'ExitPlanMode',
  ]);
});

test('a subagent stays a row of its own', () => {
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Agent', { prompt: 'look around' }, { isSubagentContainer: true }),
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  assert.equal(items.length, 3);
  assert.equal((items[1] as ChatMessage).isSubagentContainer, true);
});

test('reasoning between two calls belongs to the run; reasoning before text does not', () => {
  const between = thinkingMessage();
  const trailing = thinkingMessage();
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }),
    between,
    toolMessage('Read', { file_path: '/b.ts' }),
    trailing,
    textMessage('done'),
  ]);

  assert.equal(items.length, 3);
  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.messages.length, 3);
  assert.equal(group.messages[1], between);
  assert.equal(group.steps.length, 2);
  assert.equal(items[1], trailing);
});

test('the run carries its first timestamp, which is what a search jump matches on', () => {
  const items = groupTranscriptSteps([
    toolMessage('Read', { file_path: '/a.ts' }, { timestamp: '2024-01-01T10:00:00.000Z' }),
    toolMessage('Read', { file_path: '/b.ts' }, { timestamp: '2024-01-01T10:00:05.000Z' }),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.timestamp, '2024-01-01T10:00:00.000Z');
});

test('the summary counts kinds most frequent first and caps them at three', () => {
  const steps = [
    toolMessage('Bash', { command: 'a' }),
    toolMessage('Read', { file_path: '/a' }),
    toolMessage('Read', { file_path: '/b' }),
    toolMessage('Grep', { pattern: 'x' }),
    toolMessage('Glob', { pattern: '*.ts' }),
    toolMessage('Read', { file_path: '/c' }),
    toolMessage('WebFetch', { url: 'https://example.com' }),
    toolMessage('TodoWrite', { todos: [] }),
  ];

  // Grep and Glob count as one kind; ties keep first-appearance order.
  assert.equal(summarizeStepKinds(steps), 'Read ×3 · Search ×2 · Bash · +2');
});

test('step labels name the action and what it acted on', () => {
  assert.equal(
    describeStep(toolMessage('Edit', { file_path: '/repo/.claude/skills/implement-parity/SKILL.md' }), 'active'),
    'Editing implement-parity/SKILL.md',
  );
  assert.equal(describeStep(toolMessage('Bash', { command: 'pnpm verify\necho done' }), 'active'), 'Running pnpm verify');
  assert.equal(describeStep(toolMessage('Grep', { pattern: 'claude-api' }), 'active'), 'Searching "claude-api"');
  assert.equal(describeStep(toolMessage('Read', { file_path: 'README.md' }), 'done'), 'Read README.md');
  assert.equal(describeStep(toolMessage('WebFetch', { url: 'https://docs.example.com/a/b' }), 'done'), 'Fetched docs.example.com');
  assert.equal(describeStep(toolMessage('mcp__playwright__browser_click', { ref: 'e1' }), 'active'), 'Using browser_click (playwright)');
});

test('a call whose input is still streaming in is labelled without a target', () => {
  assert.equal(describeStep(toolMessage('Read', '{"file_pa'), 'active'), 'Reading');
});

test('duration runs from the first call to the last, and needs two calls', () => {
  const first = toolMessage('Read', {}, { timestamp: '2024-01-01T10:00:00.000Z' });
  const last = toolMessage('Read', {}, { timestamp: '2024-01-01T10:00:41.000Z' });

  assert.equal(getStepsDurationMs([first, last]), 41_000);
  assert.equal(getStepsDurationMs([first]), null);
  assert.equal(getStepsDurationMs([first, { ...last, timestamp: 'not a date' }]), null);
});

test('new rows after a baseline count a run of steps once and skip reasoning', () => {
  const seen = textMessage('what the user last saw');
  const messages = [
    textMessage('older'),
    seen,
    toolMessage('Read', { file_path: '/a' }),
    toolMessage('Read', { file_path: '/b' }),
    thinkingMessage(),
    textMessage('reply'),
  ];

  assert.equal(countTranscriptRowsAfter(messages, { message: seen, time: 0 }), 2);
});

test('the new-row count survives the baseline row being replaced by a refresh', () => {
  const messages = [
    textMessage('older'),
    { ...textMessage('seen, as persisted'), timestamp: '2024-01-01T00:00:10.000Z' },
    { ...textMessage('reply'), timestamp: '2024-01-01T00:00:20.000Z' },
  ];
  const replaced = { ...textMessage('seen, live echo'), timestamp: '2024-01-01T00:00:10.000Z' };

  assert.equal(
    countTranscriptRowsAfter(messages, { message: replaced, time: new Date('2024-01-01T00:00:10.000Z').getTime() }),
    1,
  );
});

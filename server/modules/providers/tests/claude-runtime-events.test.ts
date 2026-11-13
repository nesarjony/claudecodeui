import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { ClaudeRuntimeEvent } from '@/shared/types.js';

/**
 * Drives the real Claude runtime (`queryClaudeSDK`) against a fake `claude` executable that speaks the
 * stream-json protocol, so no model or network is involved. The scenario is chosen by the prompt text.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');

const SESSION = 'prov-fake-session';
const log = process.env.FAKE_CLAUDE_LOG;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const note = (entry) => log && fs.appendFileSync(log, JSON.stringify(entry) + '\n');
const common = () => ({ session_id: SESSION, parent_tool_use_id: null, uuid: require('node:crypto').randomUUID() });

let userUuid = null;
let pendingAsk = false;
const assistant = (content, stopReason, extra = {}) => out({
  type: 'assistant',
  message: { id: 'msg_' + Math.random().toString(16).slice(2), model: 'claude-sonnet-5-5', role: 'assistant', content, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 }, ...(extra.message || {}) },
  user_message_uuid: userUuid,
  ...common(),
  ...(extra.top || {}),
});
const toolResult = (id, content, isError) => out({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  ...common(),
});
const result = (extra = {}) => out({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: 2,
  result: 'done', stop_reason: 'end_turn', total_cost_usd: 0.25,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 },
  modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.25 } }, permission_denials: [], user_message_uuid: userUuid, ...common(), ...extra,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    const request = msg.request;
    note({ control: request.subtype, request });
    let response = {};
    if (request.subtype === 'initialize') response = { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} };
    if (request.subtype === 'get_context_usage') response = { categories: [{ name: 'Messages', tokens: 1234, color: 'x', kind: 'used' }], totalTokens: 1234, maxTokens: 200000, rawMaxTokens: 1000000, percentage: 0.6, model: 'claude-sonnet-5-5', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 167000, apiUsage: null, gridRows: [] };
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    return;
  }
  if (msg.type === 'control_response') {
    note({ controlResponse: msg.response });
    if (pendingAsk) {
      pendingAsk = false;
      note({ permissionAnswer: msg.response });
      assistant([{ type: 'text', text: 'proceeding' }], 'end_turn');
      result();
    }
    return;
  }
  if (msg.type !== 'user') return;

  userUuid = msg.uuid || null;
  const content = msg.message.content;
  const prompt = typeof content === 'string' ? content : (content.find((b) => b.type === 'text') || {}).text || '';
  note({ prompt });
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: 'default', ...common() });

  if (prompt.startsWith('/compact')) {
    // Shaped like the real CLI's answer to a slash command: the boundary, an UNSTAMPED local-command
    // assistant message, then a result stamped with the user message's uuid and local_command set.
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 480000, post_tokens: 16000, duration_ms: 5000 }, ...common() });
    out({ type: 'assistant', message: { id: 'msg_local', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Compacted' }], stop_reason: null, usage: {} }, local_command_outcome: { kind: 'completed' }, ...common() });
    return result({ result: '', local_command: 'compact' });
  }
  if (prompt === 'work') {
    assistant([{ type: 'text', text: 'Running tests.' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } }], 'tool_use');
    toolResult('tu_1', 'Exit code 1', true);
    assistant([{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/a.ts' } }, { type: 'tool_use', id: 'tu_3', name: 'Read', input: { file_path: '/b.ts' } }], 'tool_use');
    toolResult('tu_2', 'ok', false);
    toolResult('tu_3', 'ok', false);
    // Subagent traffic is not counted for the turn.
    out({ type: 'assistant', parent_tool_use_id: 'tu_agent', message: { id: 'msg_sub', model: 'claude-haiku-4', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_sub', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use', usage: {} }, session_id: SESSION, uuid: require('node:crypto').randomUUID() });
    assistant([{ type: 'text', text: 'Fixed.' }], 'end_turn');
    return result();
  }
  if (prompt === 'queued') {
    // A result for an earlier queued turn arrives before this turn's own reply: it must not end this turn.
    result({ result: 'earlier turn', user_message_uuid: 'uuid-of-an-earlier-queued-message' });
    assistant([{ type: 'text', text: 'answering now' }], 'end_turn');
    return result({ result: 'this turn' });
  }
  if (prompt === 'refuse') {
    assistant([{ type: 'text', text: '' }], 'refusal', { message: { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Blocked.' } } });
    out({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-sonnet-5-5', request_id: 'req_1', api_refusal_category: 'cyber', content: '', ...common() });
    return result({ stop_reason: 'refusal', is_error: true });
  }
  if (prompt === 'ask') {
    pendingAsk = true;
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu_perm' } });
    return;
  }
  if (prompt === 'crash') {
    process.stderr.write('fake claude crashed\n');
    process.exit(3);
  }
  assistant([{ type: 'text', text: 'hello' }], 'end_turn');
  result();
});
rl.on('close', () => process.exit(0));
`;

const DEFAULT_APPROVAL_WINDOW_MS = 2000;
let previousApprovalTimeout: string | undefined;
let directory = '';
let logFile = '';
let runtime: typeof import('@/modules/providers/list/claude/claude-runtime.provider.js');
const events: ClaudeRuntimeEvent[] = [];
const unsubscribers: Array<() => void> = [];

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-runtime-'));
  const cli = path.join(directory, 'fake-claude');
  await writeFile(cli, FAKE_CLAUDE);
  await chmod(cli, 0o755);
  logFile = path.join(directory, 'fake-claude.log');
  await writeFile(logFile, '');
  const keyFile = path.join(directory, 'api-key');
  await writeFile(keyFile, 'sk-ant-test-not-a-real-key\n', { mode: 0o600 });

  // Read when the runtime module loads, so set before importing it.
  process.env.CLAUDE_CLI_PATH = cli;
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.CLOUDCLI_ANTHROPIC_API_KEY_FILE = keyFile;
  // The runtime's own approval window, read when the module loads: short, so the tests below can outlast it.
  previousApprovalTimeout = process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS;
  process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS = String(DEFAULT_APPROVAL_WINDOW_MS);
  runtime = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
  unsubscribers.push(runtime.subscribeClaudeRuntimeEvents((event: ClaudeRuntimeEvent) => events.push(event)));
});

after(async () => {
  if (previousApprovalTimeout === undefined) delete process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS;
  else process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS = previousApprovalTimeout;
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  await rm(directory, { recursive: true, force: true });
});

type RunOutcome = { sent: Array<Record<string, unknown>>; events: ClaudeRuntimeEvent[] };

async function runPrompt(prompt: string, overrides: Record<string, unknown> = {}, sessionId = 'app-session-1'): Promise<RunOutcome> {
  const start = events.length;
  const sent: Array<Record<string, unknown>> = [];
  const writer = {
    userId: null,
    send: (message: Record<string, unknown>) => void sent.push(message),
    setSessionId: () => undefined,
  };
  await runtime.queryClaudeSDK(
    prompt,
    { sessionId, projectPath: '/mnt/dev/repo', cwd: directory, model: 'claude-sonnet-5-5@api', permissionMode: 'default', ...overrides },
    writer,
    {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async (_id: string, model: string) => model,
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    },
  );
  return { sent, events: events.slice(start) };
}

const kinds = (outcome: RunOutcome) => outcome.events.map((event) => event.kind);

test('a normal turn reports the run start, the turn result with its tool counts, and the run end', async () => {
  const outcome = await runPrompt('work');

  assert.deepEqual(kinds(outcome), ['run_started', 'turn_result', 'run_ended']);
  for (const event of outcome.events) {
    assert.equal(event.sessionId, 'app-session-1');
    assert.equal(event.projectPath, '/mnt/dev/repo');
  }

  const started = outcome.events[0] as Extract<ClaudeRuntimeEvent, { kind: 'run_started' }>;
  assert.equal(started.resumed, false);
  assert.equal(started.model, 'claude-sonnet-5-5@api');
  assert.equal(started.permissionMode, 'default');

  const turn = outcome.events[1] as Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;
  assert.equal(turn.message.type, 'result');
  assert.equal(turn.message.total_cost_usd, 0.25);
  assert.equal(turn.model, 'claude-sonnet-5-5');
  // Bash + two Reads on the main thread; the subagent's own call is not counted. One tool error.
  assert.equal(turn.toolCalls, 3);
  assert.equal(turn.toolErrors, 1);

  assert.deepEqual((outcome.events[2] as { reason: string }).reason, 'completed');
});

test('a result that belongs to an earlier queued turn does not end the turn', async () => {
  const outcome = await runPrompt('queued');
  const turns = outcome.events.filter((event) => event.kind === 'turn_result') as Array<Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>>;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].message.result, 'this turn');
});

test('a refusal is reported from the stop reason and from the structured notice', async () => {
  const outcome = await runPrompt('refuse');
  assert.deepEqual(kinds(outcome), ['run_started', 'assistant_refusal', 'system_message', 'turn_result', 'run_ended']);
  const notice = outcome.events[2] as Extract<ClaudeRuntimeEvent, { kind: 'system_message' }>;
  assert.equal(notice.message.subtype, 'model_refusal_no_fallback');
  const turn = outcome.events[3] as Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;
  assert.equal(turn.message.stop_reason, 'refusal');
});

test('a manual /compact surfaces its compact boundary, and the CLI receives the command text unchanged', async () => {
  const outcome = await runPrompt('/compact keep the task notes');
  assert.deepEqual(kinds(outcome), ['run_started', 'system_message', 'turn_result', 'run_ended']);
  const boundary = outcome.events[1] as Extract<ClaudeRuntimeEvent, { kind: 'system_message' }>;
  assert.equal(boundary.message.subtype, 'compact_boundary');

  const log = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
  assert.ok(log.some((entry) => entry.prompt === '/compact keep the task notes'), 'the slash command reaches the CLI through the prompt stream');
});

test('a permission prompt is reported with the request id, tool and input, and answering it ends the turn', async () => {
  const pending = runPrompt('ask');
  // The runtime waits for an approval from a client; find the request through the reported event.
  const request = await waitForPermissionRequest('app-session-1');
  assert.equal(request.toolName, 'Bash');
  assert.deepEqual(request.input, { command: 'rm -rf build' });
  assert.equal(request.sessionId, 'app-session-1');

  runtime.resolveToolApproval(request.requestId, { allow: true });
  const outcome = await pending;
  assert.ok(kinds(outcome).includes('turn_result'));
  assert.equal(kinds(outcome).at(-1), 'run_ended');
});

test('a CLI that dies reports the run error and ends the run as failed', async () => {
  const outcome = await runPrompt('crash', {}, 'app-session-crash');
  assert.ok(kinds(outcome).includes('run_started'));
  const failure = outcome.events.find((event) => event.kind === 'run_error') as Extract<ClaudeRuntimeEvent, { kind: 'run_error' }>;
  assert.ok(failure, 'run_error published');
  assert.ok(failure.message.length > 0);
  const ended = outcome.events.at(-1) as Extract<ClaudeRuntimeEvent, { kind: 'run_ended' }>;
  assert.equal(ended.kind, 'run_ended');
  assert.equal(ended.reason, 'error');
});

test('a run started without an app session id publishes nothing', async () => {
  const outcome = await runPrompt('work', { sessionId: undefined });
  // Provider-native ids are not addressable through the app's APIs, so such runs stay unreported.
  assert.deepEqual(outcome.events, []);
});

async function waitForPermissionRequest(sessionId: string): Promise<Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const found = events.find((event) => event.kind === 'permission_request' && event.sessionId === sessionId);
    if (found) return found as Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no permission_request for ${sessionId}`);
}

test('a live process can be steered: context usage is read in summary form and the model can be switched', async () => {
  assert.equal(runtime.isClaudeSDKSessionActive('app-session-live'), undefined, 'not live before it starts');
  assert.equal(await runtime.setClaudeSessionModel('app-session-live', 'opus'), false);
  assert.equal(await runtime.getClaudeSessionContextUsage('app-session-live'), null);

  const pending = runPrompt('ask', {}, 'app-session-live');
  const request = await waitForPermissionRequest('app-session-live');
  assert.equal(runtime.isClaudeSDKSessionActive('app-session-live'), true);

  const usage = await runtime.getClaudeSessionContextUsage('app-session-live');
  assert.equal(usage?.totalTokens, 1234);
  assert.equal(usage?.maxTokens, 200000);
  assert.equal(await runtime.setClaudeSessionModel('app-session-live', 'claude-opus-5-5'), true);

  const log = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
  const usageRequest = log.find((entry) => entry.control === 'get_context_usage');
  assert.equal(usageRequest?.request.detail, 'summary', 'no per-category token-count calls');
  assert.equal(log.find((entry) => entry.control === 'set_model')?.request.model, 'claude-opus-5-5');

  runtime.resolveToolApproval(request.requestId, { allow: true });
  await pending;
  assert.ok(!runtime.isClaudeSDKSessionActive('app-session-live'), 'gone once the run ends');
});

test('aborting a run ends it as aborted, with no turn result and no error', async () => {
  const pending = runPrompt('ask', {}, 'app-session-abort');
  await waitForPermissionRequest('app-session-abort');

  assert.equal(await runtime.abortClaudeSDKSession('app-session-abort'), true);
  const outcome = await pending;

  const own = outcome.events.filter((event) => event.sessionId === 'app-session-abort');
  assert.deepEqual(own.map((event) => event.kind), ['run_started', 'permission_request', 'run_ended']);
  assert.equal((own.at(-1) as Extract<ClaudeRuntimeEvent, { kind: 'run_ended' }>).reason, 'aborted');
});

test('a listener that throws never disturbs the run or other listeners', async () => {
  const seen: string[] = [];
  const off = [
    runtime.subscribeClaudeRuntimeEvents(() => { throw new Error('bad listener'); }),
    runtime.subscribeClaudeRuntimeEvents((event: ClaudeRuntimeEvent) => seen.push(event.kind)),
  ];
  try {
    const outcome = await runPrompt('hello');
    assert.ok(kinds(outcome).includes('turn_result'));
    assert.ok(seen.includes('turn_result'));
  } finally {
    off.forEach((unsubscribe) => unsubscribe());
  }
});

test('the API key file is detected without exposing the key', () => {
  assert.equal(runtime.hasClaudeApiKey(), true);
});

// ---------------------------------------------------------------------------------------------
// Per-session tool policy (`options.toolPolicy`): the hook the Foreman guard uses
// ---------------------------------------------------------------------------------------------

async function permissionAnswers(): Promise<Array<{ request_id: string; response: { behavior: string; message?: string; updatedInput?: unknown } }>> {
  return (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((entry) => JSON.parse(entry))
    .filter((entry) => entry.permissionAnswer)
    .map((entry) => entry.permissionAnswer);
}

test('a tool policy that allows the call lets it through: no prompt, no event, no waiting', async () => {
  const asked: Array<[string, unknown]> = [];
  const toolPolicy = (toolName: string, input: unknown) => {
    asked.push([toolName, input]);
    return { decision: 'allow' };
  };
  const before = (await permissionAnswers()).length;
  const outcome = await runPrompt('ask', { toolPolicy }, 'app-session-policy-allow');

  assert.deepEqual(asked, [['Bash', { command: 'rm -rf build' }]]);
  assert.ok(kinds(outcome).includes('turn_result'), 'the turn ran to its end without anyone answering');
  assert.ok(!kinds(outcome).includes('permission_request'));
  assert.ok(!kinds(outcome).includes('permission_resolved'));
  assert.ok(!outcome.sent.some((message) => message.kind === 'permission_request'), 'the chat UI is not asked either');

  const answers = await permissionAnswers();
  assert.equal(answers.length, before + 1);
  assert.equal(answers.at(-1)?.response.behavior, 'allow');
  assert.deepEqual(answers.at(-1)?.response.updatedInput, { command: 'rm -rf build' });
});

test('a tool policy that asks sends the call to the prompt, flagged as guarded with its category, and either side can answer', async () => {
  const toolPolicy = () => ({ decision: 'ask', category: 'command' });
  const pending = runPrompt('ask', { toolPolicy }, 'app-session-policy-ask');
  const request = await waitForPermissionRequest('app-session-policy-ask');
  assert.equal(request.toolName, 'Bash');
  assert.deepEqual(request.input, { command: 'rm -rf build' });
  assert.equal(request.guarded, true);
  assert.equal(request.category, 'command');

  // It is listed as pending (this is what the bridge answers through), exactly like any prompt.
  assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-policy-ask').map((entry: { requestId: string }) => entry.requestId), [request.requestId]);

  runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Pushing is not part of this task.' });
  const outcome = await pending;

  const resolved = outcome.events.find((event) => event.kind === 'permission_resolved') as Extract<ClaudeRuntimeEvent, { kind: 'permission_resolved' }>;
  assert.equal(resolved?.requestId, request.requestId);
  assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-policy-ask'), []);
  assert.ok(outcome.sent.some((message) => message.kind === 'permission_request' && message.requestId === request.requestId), 'the chat UI is asked too');
  assert.ok(outcome.sent.some((message) => message.kind === 'permission_resolved' && message.requestId === request.requestId), 'and told when it was settled');

  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, 'Pushing is not part of this task.');
  assert.ok(kinds(outcome).includes('turn_result'));
});

test('a policy that throws asks instead of allowing', async () => {
  const toolPolicy = () => { throw new Error('classifier exploded'); };
  const pending = runPrompt('ask', { toolPolicy }, 'app-session-policy-throw');
  const request = await waitForPermissionRequest('app-session-policy-throw');
  assert.equal(request.guarded, true);
  assert.equal(request.category, null);
  runtime.resolveToolApproval(request.requestId, { allow: true });
  await pending;
});

test('a run without a policy is unchanged: its prompt carries no guard fields and is resolved by the answer', async () => {
  const pending = runPrompt('ask', {}, 'app-session-no-policy');
  const request = await waitForPermissionRequest('app-session-no-policy');
  assert.equal('guarded' in request, false);
  assert.equal('category' in request, false);
  runtime.resolveToolApproval(request.requestId, { allow: true });
  const outcome = await pending;
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
});

test('an aborted guarded prompt is not reported as resolved: the run just ends', async () => {
  const pending = runPrompt('ask', { toolPolicy: () => ({ decision: 'ask', category: 'command' }) }, 'app-session-policy-abort');
  await waitForPermissionRequest('app-session-policy-abort');
  assert.equal(await runtime.abortClaudeSDKSession('app-session-policy-abort'), true);
  const outcome = await pending;
  const own = outcome.events.filter((event) => event.sessionId === 'app-session-policy-abort');
  assert.deepEqual(own.map((event) => event.kind), ['run_started', 'permission_request', 'run_ended']);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('an unguarded prompt keeps the runtime\'s own approval window and its plain timeout message', async () => {
  const outcome = await runPrompt('ask', {}, 'app-session-env-timeout');
  assert.ok(kinds(outcome).includes('turn_result'), 'the run goes on after the denial');
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, 'Permission request timed out');
  assert.ok(outcome.sent.some((message) => message.kind === 'permission_cancelled' && message.reason === 'timeout'));
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved'), 'a timeout settles the prompt too');
});

test('a policy\'s timeoutMs outlasts the runtime\'s window: still pending after it, and a later answer is honoured', async () => {
  const toolPolicy = () => ({ decision: 'ask', category: 'command', timeoutMs: 20_000, timeoutMessage: 'Timed out waiting for a person.' });
  const pending = runPrompt('ask', { toolPolicy }, 'app-session-policy-long-wait');
  const request = await waitForPermissionRequest('app-session-policy-long-wait');

  await sleep(DEFAULT_APPROVAL_WINDOW_MS + 700);
  assert.deepEqual(
    runtime.getPendingApprovalsForSession('app-session-policy-long-wait').map((entry: { requestId: string }) => entry.requestId),
    [request.requestId],
    'the unguarded window has passed and the guarded prompt is still waiting',
  );

  runtime.resolveToolApproval(request.requestId, { allow: true });
  const outcome = await pending;
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'allow');
  assert.ok(kinds(outcome).includes('turn_result'));
});

test('when a guarded prompt times out the worker is told it timed out waiting for a person, and a late answer finds nothing', async () => {
  const message = 'Timed out waiting for a person to approve this Bash call: no one answered within 1 second. This is a timeout, not a decision.';
  const toolPolicy = () => ({ decision: 'ask', category: 'command', timeoutMs: 300, timeoutMessage: message });
  const started = Date.now();
  const outcome = await runPrompt('ask', { toolPolicy }, 'app-session-policy-timeout');
  assert.ok(Date.now() - started < DEFAULT_APPROVAL_WINDOW_MS, 'the policy\'s window applied, not the longer default');

  const request = outcome.events.find((event) => event.kind === 'permission_request') as Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>;
  assert.equal(request.guarded, true);
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, message);
  assert.ok(outcome.sent.some((message_) => message_.kind === 'permission_cancelled' && message_.requestId === request.requestId && message_.reason === 'timeout'), 'the chat UI retracts the prompt');
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
  assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-policy-timeout'), []);

  // A late answer has nothing to resolve (the bridge reports it as 404 NO_PENDING_PERMISSION) and changes nothing.
  assert.doesNotThrow(() => runtime.resolveToolApproval(request.requestId, { allow: true }));
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
});

test('a policy without a timeoutMessage still denies a timeout with the runtime\'s plain message', async () => {
  const toolPolicy = () => ({ decision: 'ask', category: 'command', timeoutMs: 200 });
  await runPrompt('ask', { toolPolicy }, 'app-session-policy-timeout-plain');
  assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Permission request timed out');
});

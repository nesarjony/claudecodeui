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
// How the runtime started this process: the command line and the Foreman-controlled environment.
note({ spawn: { argv: process.argv.slice(2), catchAll: process.env.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL ?? null } });
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
  if (prompt === 'askq' || prompt === 'askplan') {
    // The tools only a person can answer, sent straight to canUseTool.
    pendingAsk = true;
    const question = { questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] }] };
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: prompt === 'askq' ? 'AskUserQuestion' : 'ExitPlanMode', input: prompt === 'askq' ? question : { plan: '# Plan' }, tool_use_id: 'tu_interactive' } });
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

// ---------------------------------------------------------------------------------------------
// Host-supplied SDK hooks (`options.toolHooks`): merged into the run's own, never replacing them
// ---------------------------------------------------------------------------------------------

async function initializeHooks(): Promise<Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>>> {
  const initializes = (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((entry) => JSON.parse(entry))
    .filter((entry) => entry.control === 'initialize');
  return initializes.at(-1)?.request?.hooks ?? {};
}

test('a run without host hooks registers only its own hooks', async () => {
  await runPrompt('hello', {}, 'app-session-hooks-none');
  const hooks = await initializeHooks();
  assert.deepEqual(Object.keys(hooks), ['Notification']);
});

test('host hooks join the run\'s own: Notification stays, PreToolUse is added', async () => {
  const toolHooks = { PreToolUse: [{ matcher: '', hooks: [async () => ({})] }] };
  const outcome = await runPrompt('hello', { toolHooks }, 'app-session-hooks-merge');
  assert.ok(kinds(outcome).includes('turn_result'));
  const hooks = await initializeHooks();
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PreToolUse']);
  assert.equal(hooks.Notification.length, 1);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, '');
  assert.equal(hooks.PreToolUse[0].hookCallbackIds.length, 1);
});

test('host hooks for an event the run already hooks are appended after its own matchers', async () => {
  const toolHooks = { Notification: [{ matcher: 'extra', hooks: [async () => ({})] }] };
  await runPrompt('hello', { toolHooks }, 'app-session-hooks-append');
  const hooks = await initializeHooks();
  assert.deepEqual(hooks.Notification.map((matcher) => matcher.matcher), ['', 'extra']);
});

// ---------------------------------------------------------------------------------------------
// Foreman's two ways into a run side by side: its compaction hooks (the runtime additions provider) and the guard
// (`options.toolPolicy` for canUseTool, `options.toolHooks` for PreToolUse)
// ---------------------------------------------------------------------------------------------

const FOREMAN_REPO = '/mnt/dev/repo'; // the project path runPrompt gives a run by default

// Stand-ins shaped like what the Foreman bridge hands over (the real ones are exercised through the bridge module in
// foreman-guard-integration.test.ts): the additions provider answers compaction hooks for a Foreman repo only, and a
// guarded run carries a policy for canUseTool and a PreToolUse hook.
const noopHook = { matcher: '', hooks: [async () => ({})] };
const foremanAdditions = async (session: { sessionId: string; projectPath: string | null }) =>
  session.projectPath === FOREMAN_REPO ? { hooks: { PreCompact: [noopHook], SessionStart: [noopHook] } } : {};
const guardOptions = () => ({ toolPolicy: () => ({ decision: 'ask', category: 'command' }), toolHooks: { PreToolUse: [noopHook] } });

test('a guarded Foreman session registers the guard (PreToolUse and canUseTool) and the compaction hooks together', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(foremanAdditions);
  try {
    const pending = runPrompt('ask', guardOptions(), 'app-session-both');
    // canUseTool is wired: the risky Bash call is held, flagged as guarded.
    const request = await waitForPermissionRequest('app-session-both');
    assert.equal(request.guarded, true);
    assert.equal(request.category, 'command');

    const registered = await initializeHooks();
    assert.deepEqual(Object.keys(registered).sort(), ['Notification', 'PreCompact', 'PreToolUse', 'SessionStart']);
    for (const event of Object.keys(registered)) {
      assert.equal(registered[event].length, 1, `${event} keeps exactly one matcher`);
      assert.equal(registered[event][0].hookCallbackIds.length, 1, `${event} keeps exactly one callback`);
    }

    runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not in this task.' });
    const outcome = await pending;
    assert.ok(kinds(outcome).includes('turn_result'));
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('a session that is neither guarded nor in a Foreman repo gets neither the guard nor the compaction hooks', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(foremanAdditions);
  try {
    await runPrompt('hello', { projectPath: '/mnt/dev/elsewhere' }, 'app-session-neither');
    assert.deepEqual(Object.keys(await initializeHooks()), ['Notification']);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('either half alone: the guard outside a Foreman repo adds only PreToolUse, a Foreman repo without a guard only the compaction hooks', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(foremanAdditions);
  try {
    await runPrompt('hello', { ...guardOptions(), projectPath: '/mnt/dev/elsewhere' }, 'app-session-guard-only');
    assert.deepEqual(Object.keys(await initializeHooks()).sort(), ['Notification', 'PreToolUse']);

    await runPrompt('hello', {}, 'app-session-compaction-only');
    assert.deepEqual(Object.keys(await initializeHooks()).sort(), ['Notification', 'PreCompact', 'SessionStart']);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

// ---------------------------------------------------------------------------------------------
// Foreman's refusal fallback model and denied tools, from the runtime additions provider
// ---------------------------------------------------------------------------------------------

const settingsWith = (overrides: Record<string, unknown>) => ({ allowedTools: [], disallowedTools: [], skipPermissions: false, ...overrides });

async function lastSpawn(): Promise<{ argv: string[]; catchAll: string | null }> {
  const spawns = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((entry) => JSON.parse(entry)).filter((entry) => entry.spawn);
  return spawns.at(-1).spawn;
}
const argValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test('the additions provider is asked with the run\'s SDK model, without the @api marker', async () => {
  const asked: Array<{ sessionId: string; projectPath: string | null; model?: string }> = [];
  runtime.setClaudeRuntimeAdditionsProvider(async (session: { sessionId: string; projectPath: string | null; model?: string }) => {
    asked.push(session);
    return {};
  });
  try {
    await runPrompt('hello', {}, 'app-session-asked-model');
    assert.deepEqual(asked, [{ sessionId: 'app-session-asked-model', projectPath: '/mnt/dev/repo', model: 'claude-sonnet-5-5' }]);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('a fallback model and denied tools from the additions reach the CLI, next to the settings\' own disallowed tools', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({
    fallbackModel: 'claude-opus-5-5',
    disallowedTools: ['mcp__infigraph__save_session', 'Bash(rm:*)'],
    env: { CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '1' },
  }));
  try {
    const outcome = await runPrompt('hello', { toolsSettings: settingsWith({ disallowedTools: ['Bash(rm:*)', 'WebFetch'] }) }, 'app-session-fallback');
    assert.ok(kinds(outcome).includes('turn_result'));
    const { argv, catchAll } = await lastSpawn();
    assert.equal(argValue(argv, '--fallback-model'), 'claude-opus-5-5');
    assert.deepEqual(argValue(argv, '--disallowedTools').split(/[ ,]+/).sort(), ['Bash(rm:*)', 'WebFetch', 'mcp__infigraph__save_session']);
    assert.equal(catchAll, '1');
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('without additions the CLI gets no fallback model, and a run without the provider is unchanged', async () => {
  await runPrompt('hello', { toolsSettings: settingsWith({ disallowedTools: ['WebFetch'] }) }, 'app-session-no-fallback');
  const { argv, catchAll } = await lastSpawn();
  assert.equal(argv.includes('--fallback-model'), false);
  assert.equal(argValue(argv, '--disallowedTools'), 'WebFetch');
  assert.equal(catchAll, null);
});

test('a tool Foreman denies is refused by canUseTool at once, in a bypass mode too, with no prompt', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({ disallowedTools: ['Bash'] }));
  try {
    const plain = await runPrompt('ask', {}, 'app-session-foreman-deny');
    assert.ok(!kinds(plain).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Tool disallowed by settings');

    const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-foreman-deny-bypass');
    assert.ok(!kinds(bypass).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

// ---------------------------------------------------------------------------------------------
// canUseTool: a call the guard holds is not waved through by a stored allow rule or a bypass mode
// ---------------------------------------------------------------------------------------------

const heldByPolicy = () => ({ decision: 'ask', category: 'command' });

test('without a guard a stored allow rule or a bypass mode settles the call by itself, as before', async () => {
  const before = (await permissionAnswers()).length;
  const rule = await runPrompt('ask', { toolsSettings: settingsWith({ allowedTools: ['Bash'] }) }, 'app-session-rule-unguarded');
  assert.ok(!kinds(rule).includes('permission_request'));
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'allow');

  const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-bypass-unguarded');
  assert.ok(!kinds(bypass).includes('permission_request'));
  assert.equal((await permissionAnswers()).length, before + 2);
});

test('a call the policy holds is asked about even when a stored allow rule matches it', async () => {
  const pending = runPrompt('ask', { toolPolicy: heldByPolicy, toolsSettings: settingsWith({ allowedTools: ['Bash'] }) }, 'app-session-rule-guarded');
  const request = await waitForPermissionRequest('app-session-rule-guarded');
  assert.equal(request.guarded, true);
  runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Held for a person.' });
  await pending;
  assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Held for a person.');
});

test('a call the policy holds is asked about even in a bypass mode', async () => {
  const pending = runPrompt('ask', { toolPolicy: heldByPolicy, toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-bypass-guarded');
  const request = await waitForPermissionRequest('app-session-bypass-guarded');
  assert.equal(request.guarded, true);
  runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Held for a person.' });
  await pending;
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
});

test('a tool the settings disallow is still denied outright for a guarded run, with no prompt', async () => {
  const outcome = await runPrompt('ask', { toolPolicy: heldByPolicy, toolsSettings: settingsWith({ disallowedTools: ['Bash'] }) }, 'app-session-disallowed-guarded');
  assert.ok(!kinds(outcome).includes('permission_request'));
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, 'Tool disallowed by settings');
});

// ---------------------------------------------------------------------------------------------
// canUseTool for the tools only a person can answer (AskUserQuestion, ExitPlanMode): a guarded run has nobody to ask
// ---------------------------------------------------------------------------------------------

const INTERACTIVE_TOOLS = [
  { prompt: 'askq', toolName: 'AskUserQuestion' },
  { prompt: 'askplan', toolName: 'ExitPlanMode' },
] as const;
const UNATTENDED_REASON = 'Foreman guard: no person is available to answer this in this session.';

// Without the guard's refusal such a run waits for a person for ever (these prompts have no timeout): give up on it and
// end the run instead of hanging the whole suite.
async function settlesWithin(pending: Promise<RunOutcome>, sessionId: string, ms = 5000): Promise<RunOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void runtime.abortClaudeSDKSession(sessionId);
      reject(new Error(`${sessionId} was still waiting for a person after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([pending, giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

function assertNobodyWasAsked(outcome: RunOutcome, sessionId: string): void {
  assert.ok(!kinds(outcome).includes('permission_request'), 'no permission_request event');
  assert.ok(!kinds(outcome).includes('permission_resolved'), 'nothing to resolve');
  assert.ok(!outcome.sent.some((message) => message.kind === 'permission_request' || message.kind === 'permission_cancelled'), 'the chat UI is not asked either');
  assert.deepEqual(runtime.getPendingApprovalsForSession(sessionId), [], 'nothing is pending');
  assert.ok(kinds(outcome).includes('turn_result'), 'the turn ran to its end');
}

for (const { prompt, toolName } of INTERACTIVE_TOOLS) {
  test(`a guarded run's ${toolName} is denied at once with the policy's reason: no prompt, no event, no waiting`, async () => {
    const sessionId = `app-session-unattended-${prompt}`;
    const asked: string[] = [];
    const toolPolicy = (name: string) => {
      asked.push(name);
      return { decision: 'deny', message: UNATTENDED_REASON };
    };
    const before = (await permissionAnswers()).length;
    const outcome = await settlesWithin(runPrompt(prompt, { toolPolicy }, sessionId), sessionId);

    assert.deepEqual(asked, [toolName], 'the policy was asked about the call');
    assertNobodyWasAsked(outcome, sessionId);
    const answers = await permissionAnswers();
    assert.equal(answers.length, before + 1);
    assert.equal(answers.at(-1)?.response.behavior, 'deny');
    assert.equal(answers.at(-1)?.response.message, UNATTENDED_REASON);
  });

  test(`a guarded run's ${toolName} is still denied at once when its policy gives no reason, says allow or ask, or throws`, async () => {
    const policies: Array<[string, () => unknown]> = [
      ['no reason', () => ({ decision: 'deny' })],
      ['allow', () => ({ decision: 'allow' })],
      ['ask', () => ({ decision: 'ask', category: 'command' })],
      ['throw', () => { throw new Error('classifier exploded'); }],
    ];
    for (const [label, toolPolicy] of policies) {
      const sessionId = `app-session-unattended-fallback-${prompt}-${label.replace(' ', '-')}`;
      const outcome = await settlesWithin(runPrompt(prompt, { toolPolicy }, sessionId), sessionId);
      assertNobodyWasAsked(outcome, sessionId);
      const answer = (await permissionAnswers()).at(-1);
      assert.equal(answer?.response.behavior, 'deny', label);
      assert.match(answer?.response.message ?? '', /^No person is available to answer this tool call in this session, because it runs unattended\./, label);
    }
  });

  test(`a guarded run's ${toolName} is denied even when settings would allow it or skip permissions`, async () => {
    const sessionId = `app-session-unattended-settings-${prompt}`;
    const toolsSettings = settingsWith({ skipPermissions: true, allowedTools: ['AskUserQuestion', 'ExitPlanMode'] });
    const outcome = await settlesWithin(runPrompt(prompt, { toolPolicy: heldByPolicy, toolsSettings }, sessionId), sessionId);
    assertNobodyWasAsked(outcome, sessionId);
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  });

  test(`an unguarded run's ${toolName} still prompts a person and waits for the answer, with no timeout`, async () => {
    const sessionId = `app-session-interactive-${prompt}`;
    const pending = runPrompt(prompt, {}, sessionId);
    const request = await waitForPermissionRequest(sessionId);
    assert.equal(request.toolName, toolName);
    assert.equal('guarded' in request, false);
    assert.deepEqual(runtime.getPendingApprovalsForSession(sessionId).map((entry: { requestId: string }) => entry.requestId), [request.requestId]);

    if (toolName === 'AskUserQuestion') {
      // The approval window the other prompts have does not apply to these: still waiting after it.
      await sleep(DEFAULT_APPROVAL_WINDOW_MS + 700);
      assert.equal(runtime.getPendingApprovalsForSession(sessionId).length, 1);
    }

    runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not now.' });
    const outcome = await settlesWithin(pending, sessionId);
    assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
    const answer = (await permissionAnswers()).at(-1);
    assert.equal(answer?.response.behavior, 'deny');
    assert.equal(answer?.response.message, 'Not now.');
  });
}

test('a policy that refuses an ordinary call outright is obeyed at once, even in a bypass mode, with no prompt', async () => {
  const sessionId = 'app-session-policy-deny-bash';
  const toolPolicy = () => ({ decision: 'deny', message: 'Not allowed in this session.' });
  const outcome = await settlesWithin(runPrompt('ask', { toolPolicy, toolsSettings: settingsWith({ skipPermissions: true }) }, sessionId), sessionId);
  assert.ok(!kinds(outcome).includes('permission_request'));
  assert.ok(!outcome.sent.some((message) => message.kind === 'permission_request'));
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, 'Not allowed in this session.');
});

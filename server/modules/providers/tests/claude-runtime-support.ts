import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';

import { setClaudeRuntimeSandboxProvider, type RuntimeSandboxProvider } from '@/modules/providers/list/claude/claude-runtime-sandbox.js';
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
// How the runtime started this process: the command line and the environment it was given.
// The routing-relevant slice of the environment (all test values, none real): what decides where the request goes and with which credential.
const routing = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(ANTHROPIC_|CLAUDE_AGENT_API|CLAUDE_CODE_(OAUTH|USE_|SUBAGENT))/.test(name)));
note({ spawn: { argv: process.argv.slice(2), catchAll: process.env.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL ?? null, env: routing, scratch: { tmpdir: process.env.TMPDIR ?? null, claudeTmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null, autocompact: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null } } });
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
  if (prompt === 'rate-limited') {
    // The CLI retries a refused request (a notice per try), then gives up: an assistant message that carries the SDK's own classification.
    out({ type: 'system', subtype: 'api_error', level: 'error', error: { status: 429, message: '429 {"error":{"type":"profile_quota"}}' }, ...common() });
    out({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Request rejected (429)' }], stop_reason: 'stop_sequence', usage: {} }, ...common() });
    return result({ is_error: true, result: 'API Error: Request rejected (429)' });
  }
  if (prompt === 'ask') {
    pendingAsk = true;
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu_perm' } });
    return;
  }
  if (prompt.startsWith('ask-tool:')) {
    // A call of the named tool that the CLI hands to canUseTool (it would not for a tool in --allowedTools).
    pendingAsk = true;
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: prompt.slice('ask-tool:'.length), input: { file_path: '/mnt/dev/repo/notes.md', content: 'x', url: 'https://example.com' }, tool_use_id: 'tu_tool' } });
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

export const DEFAULT_APPROVAL_WINDOW_MS = 2000;

type Runtime = typeof import('@/modules/providers/list/claude/claude-runtime.provider.js');

// Live bindings: set by the `before` hook that `useFakeClaudeRuntime` registers, read by the tests as plain module values.
export let runtime: Runtime;
export let directory = '';
export let logFile = '';
export const events: ClaudeRuntimeEvent[] = [];

/** Starts the fake CLI and loads the runtime against it; call once at the top of a test file. */
export function useFakeClaudeRuntime(): void {
  let previousApprovalTimeout: string | undefined;
  const unsubscribers: Array<() => void> = [];

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-'));
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
    // The runtime's own approval window, read when the module loads: short, so the tests can outlast it.
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
}

export type RunOutcome = { sent: Array<Record<string, unknown>>; events: ClaudeRuntimeEvent[] };

export async function runPrompt(prompt: string, overrides: Record<string, unknown> = {}, sessionId = 'app-session-1'): Promise<RunOutcome> {
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

export const kinds = (outcome: RunOutcome) => outcome.events.map((event) => event.kind);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPermissionRequest(sessionId: string): Promise<Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const found = events.find((event) => event.kind === 'permission_request' && event.sessionId === sessionId);
    if (found) return found as Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>;
    await sleep(20);
  }
  throw new Error(`no permission_request for ${sessionId}`);
}

/** Everything the fake CLI has noted so far: how it was started, what it was asked, what it was answered. */
export async function readLog(): Promise<Array<Record<string, any>>> {
  return (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
}

export async function permissionAnswers(): Promise<Array<{ request_id: string; response: { behavior: string; message?: string; updatedInput?: unknown } }>> {
  return (await readLog()).filter((entry) => entry.permissionAnswer).map((entry) => entry.permissionAnswer);
}

export async function initializeHooks(): Promise<Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>>> {
  const initializes = (await readLog()).filter((entry) => entry.control === 'initialize');
  return initializes.at(-1)?.request?.hooks ?? {};
}

export async function lastSpawn(): Promise<{ argv: string[]; catchAll: string | null; env: Record<string, string>; scratch: { tmpdir: string | null; claudeTmpdir: string | null; autocompact: string | null } }> {
  return (await readLog()).filter((entry) => entry.spawn).at(-1)?.spawn;
}

/**
 * The value the CLI got for `flag`. The SDK spells some flags `--flag value` and others `--flag=value` (0.3.328 moved most of them to the
 * second form), so both are read; '' when the flag is absent.
 */
export const argValue = (argv: string[], flag: string): string => {
  const joined = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (joined !== undefined) return joined.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index === -1 ? '' : argv[index + 1];
};

/** Whether the CLI got `flag`, in either spelling (see argValue). */
export const hasFlag = (argv: string[], flag: string): boolean => argv.includes(flag) || argv.some((arg) => arg.startsWith(`${flag}=`));

/** The settings object of a run's tool settings (what the UI stores): no allow rules, no denials, no bypass unless overridden. */
export const settingsWith = (overrides: Record<string, unknown>) => ({ allowedTools: [], disallowedTools: [], skipPermissions: false, ...overrides });

/** Runs `run` with `provider` registered as the sandbox provider, and takes it away again. */
export async function withSandboxProvider<T>(provider: (...asked: Parameters<RuntimeSandboxProvider>) => unknown, run: () => Promise<T>): Promise<T> {
  setClaudeRuntimeSandboxProvider(provider as RuntimeSandboxProvider);
  try {
    return await run();
  } finally {
    setClaudeRuntimeSandboxProvider(null);
  }
}

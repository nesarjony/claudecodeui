import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import express from 'express';

import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * Milestone 6 end to end inside one process: the real bridge module, database, Claude runtime and SDK, with a fake `claude`
 * executable that plays a subagent's tool call the way Claude Code 2.1.286 does (seen in a real run): every PreToolUse hook
 * whose matcher fits is called with `agent_id` and `agent_type` in its input, a `deny` from any of them settles the call, an
 * `ask` sends it to `can_use_tool` (with `agent_id`), and otherwise the CLI allows it by itself. A call that no rule settled is
 * sent to `can_use_tool` too, which is what a sandboxed worker's unmatched call does. The fake records how it was started (the
 * command line: the sandbox rides in `--settings`) and the `agents` the SDK handed over in its initialize request. Only Foreman's
 * end (runtime config, event intake) is a stub.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SESSION = 'prov-' + crypto.randomUUID();
const log = process.env.FAKE_CLAUDE_LOG;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const note = (entry) => log && fs.appendFileSync(log, JSON.stringify(entry) + '\n');
// How the run started: the command line (the SDK's sandbox and permission rules ride in --settings) and the sandbox's environment.
note({ spawn: { argv: process.argv.slice(2), tmpdir: process.env.TMPDIR ?? null, claudeTmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null } });
const common = () => ({ session_id: SESSION, parent_tool_use_id: null, uuid: crypto.randomUUID() });
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 };

let userUuid = null;
let preToolUse = [];
const waiting = new Map();
const ask = (request) => new Promise((resolve) => {
  const id = 'req-' + crypto.randomUUID();
  waiting.set(id, resolve);
  out({ type: 'control_request', request_id: id, request });
});
const finish = (text) => {
  out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }, user_message_uuid: userUuid, ...common() });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: text, stop_reason: 'end_turn', total_cost_usd: 0.01, usage, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } }, permission_denials: [], user_message_uuid: userUuid, ...common() });
};

async function toolCall(tool, input, agentType) {
  const agent = agentType ? { agent_id: 'a5658d5805ab2df3e', agent_type: agentType } : {};
  const outputs = [];
  for (const matcher of preToolUse.filter((entry) => !entry.matcher || entry.matcher === tool)) {
    for (const id of matcher.ids) {
      const output = await ask({ subtype: 'hook_callback', callback_id: id, tool_use_id: 'tu_s', input: { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd: process.cwd(), permission_mode: 'default', ...agent, tool_name: tool, tool_input: input, tool_use_id: 'tu_s' } });
      outputs.push({ matcher: matcher.matcher, output: output || {} });
    }
  }
  const decisions = outputs.map((entry) => entry.output.hookSpecificOutput && entry.output.hookSpecificOutput.permissionDecision);
  let settled;
  if (decisions.includes('deny')) settled = { behavior: 'deny', by: 'hook' };
  else if (decisions.includes('ask')) settled = await ask({ subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tu_s', ...(agentType ? { agent_id: agent.agent_id } : {}) });
  else settled = { behavior: 'allow', by: 'cli' };
  note({ call: tool, agentType: agentType || null, input, outputs, settled });
  finish('done');
}

// A call no rule settled: the CLI asks its host through can_use_tool, whatever the hooks said.
async function askCall(tool, arg, agentType) {
  const input = tool === 'Read' ? { file_path: process.cwd() + '/' + arg } : tool === 'AskUserQuestion' ? { questions: [{ question: arg, header: 'Q', multiSelect: false, options: [] }] } : { command: arg };
  const settled = await ask({ subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tu_a', ...(agentType ? { agent_id: 'a5658d5805ab2df3e' } : {}) });
  note({ call: tool, agentType: agentType || null, input, outputs: [], settled });
  finish('done');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'initialize') {
      preToolUse = ((msg.request.hooks || {}).PreToolUse || []).map((entry) => ({ matcher: entry.matcher, ids: entry.hookCallbackIds }));
      note({ initialized: Object.keys(msg.request.hooks || {}).sort(), preToolUseMatchers: preToolUse.map((entry) => entry.matcher), agents: msg.request.agents || null });
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: msg.request.subtype === 'initialize' ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {} } });
    return;
  }
  if (msg.type === 'control_response') {
    const resolve = waiting.get(msg.response.request_id);
    if (resolve) {
      waiting.delete(msg.response.request_id);
      resolve(msg.response.response);
    }
    return;
  }
  if (msg.type !== 'user') return;
  userUuid = msg.uuid || null;
  const content = msg.message.content;
  const prompt = typeof content === 'string' ? content : (content.find((block) => block.type === 'text') || {}).text || '';
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: 'default', ...common() });
  // "bash|<agent>|<command>", "read|<agent>|<file>" and "ask|<agent>|<tool>|<argument>"; an empty agent is the main worker.
  const [kind, agentType, ...rest] = prompt.split('|');
  if (kind === 'ask') {
    void askCall(rest[0], rest.slice(1).join('|'), agentType);
    return;
  }
  if (kind === 'bash') {
    void toolCall('Bash', { command: rest.join('|') }, agentType);
    return;
  }
  if (kind === 'read') {
    void toolCall('Read', { file_path: process.cwd() + '/' + rest.join('|') }, agentType);
    return;
  }
  finish('hello');
});
rl.on('close', () => process.exit(0));
`;


const TOKEN = 'delegation-integration-token';
// What cloudcli presents to Foreman's intake: a token of its own, since the push never uses the bridge token.
const INTAKE_TOKEN = 'delegation-integration-intake-token';
// What Foreman's runtime config carries for Milestone 6 (two of its default agents, the test runner's list shortened).
const DELEGATION = {
  enabled: true,
  agents: {
    explorer: { description: 'Searches and reads code.', prompt: 'You are a read-only explorer.', tools: ['Read', 'Grep', 'Glob'], model: 'haiku' },
    'test-runner': {
      description: 'Runs the tests.',
      prompt: 'You run verification commands.',
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      model: 'haiku',
      bashAllow: ['^(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|tests|lint|build)(\\s|$)', '^node\\s+--test(\\s|$)'],
      maxTurns: 20,
    },
  },
};

type PushedEvent = { id: string; sessionId: string; sequence: number; kind: string; payload: Record<string, any> };

let directory = '';
let logFile = '';
let projectDir = '';
let scratchDir = '';
let baseUrl = '';
let appUrl = '';
let server: http.Server;
let foremanServer: http.Server;
let database: typeof import('@/modules/database/index.js');
let createOwnerSession: (message: string) => string;
const pushed: PushedEvent[] = [];
const pushedWith: string[] = [];
const restore: Array<() => void> = [];

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-delegation-int-'));
  projectDir = path.join(directory, 'project');
  scratchDir = path.join(directory, 'scratch', 'batch-1');
  await mkdir(projectDir);
  const cli = path.join(directory, 'fake-claude');
  await writeFile(cli, FAKE_CLAUDE);
  await chmod(cli, 0o755);
  logFile = path.join(directory, 'fake-claude.log');
  await writeFile(logFile, '');
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const eventsTokenFile = path.join(directory, 'intake-token');
  await writeFile(eventsTokenFile, INTAKE_TOKEN, { mode: 0o600 });

  foremanServer = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url?.endsWith('/foreman/runtime-config')) {
        // No compaction hooks here (no repos), so the only PreToolUse matcher a run registers is the subagent rule.
        response.end(JSON.stringify({ repos: [], workerAutoCompactPct: 70, hooks: { enabled: false, preCompactBudgetMs: 20_000, sessionStartMaxChars: 6000 }, delegation: DELEGATION }));
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/foreman/events')) {
        // Any 2xx acknowledges the event; a repeat of one Foreman already has is acknowledged too.
        pushed.push(JSON.parse(body));
        pushedWith.push(String(request.headers.authorization));
        response.end('{}');
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
  });
  foremanServer.listen(0, '127.0.0.1');
  await once(foremanServer, 'listening');

  setEnv('CLAUDE_CLI_PATH', cli);
  setEnv('FAKE_CLAUDE_LOG', logFile);
  setEnv('DATABASE_PATH', path.join(directory, 'auth.db'));
  setEnv('FOREMAN_BRIDGE_TOKEN_FILE', tokenFile);
  setEnv('FOREMAN_EVENTS_TOKEN_FILE', eventsTokenFile);
  setEnv('FOREMAN_EVENTS_URL', `http://127.0.0.1:${(foremanServer.address() as AddressInfo).port}/foreman/events`);
  setEnv('CLOUDCLI_ANTHROPIC_API_KEY_FILE', path.join(directory, 'no-key'));

  database = await import('@/modules/database/index.js');
  database.closeConnection();
  await database.initializeDatabase();
  database.projectsDb.createProjectPath(projectDir);

  const { sessionsService } = await import('@/modules/providers/index.js');
  createOwnerSession = (message) => sessionsService.createAppSession('claude', projectDir, message).sessionId;
  const { authenticateToken, authRoutes } = await import('@/modules/auth/index.js');
  const { createForemanModule, createForemanUiModule } = await import('@/modules/foreman/index.js');
  const bridge = createForemanModule();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/foreman', bridge.router);
  // As the server entrypoint mounts it: behind cloudcli's own login.
  app.use('/api/foreman-suggestions', authenticateToken, createForemanUiModule(bridge));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `${appUrl}/api/foreman`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => foremanServer.close(() => resolve()));
  database.closeConnection();
  restore.forEach((undo) => undo());
  await rm(directory, { recursive: true, force: true });
});

// Every call that changes a session carries its own idempotency key; a test that looks at the key passes one.
let nextKey = 1;
const SESSION_CHANGING = /^\/sessions(\/[^/]+\/(message|interrupt|model|compact|permission|adopt|release))?$/;

async function api(method: string, pathname: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const keyed = method === 'POST' && SESSION_CHANGING.test(pathname) && !(body && 'idempotencyKey' in body);
  const sent = keyed ? { ...(body ?? {}), idempotencyKey: `delegation-${nextKey++}` } : body;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(sent !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: sent !== undefined ? JSON.stringify(sent) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function until<T>(what: string, probe: () => Promise<T | null | false | undefined> | T | null | false | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const fakeLog = async () => (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
const statusOf = async (sessionId: string) =>
  ((await api('GET', '/sessions')).body.data.sessions as Array<{ id: string; status: string }>).find((entry) => entry.id === sessionId)?.status;
const idle = (sessionId: string) => until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');

/** What Foreman sends with every start: the isolation of the task. The scratch space and the CLI's temp directories live under the batch folder. */
const sandboxPolicy = (overrides: Partial<ReturnType<typeof samplePolicy>> = {}) =>
  samplePolicy({ scratchDir, env: { TMPDIR: `${scratchDir}/tmp`, CLAUDE_CODE_TMPDIR: `${scratchDir}/cc` }, ...overrides });

async function run(prompt: string, sandbox = sandboxPolicy()): Promise<{ sessionId: string; mark: number }> {
  const mark = (await fakeLog()).length;
  const started = await api('POST', '/sessions', {
    projectPath: projectDir,
    prompt,
    billing: 'subscription',
    permissionMode: 'default',
    sandbox,
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.data.sandboxed, true);
  return { sessionId: started.body.data.sessionId as string, mark };
}

const settledCall = (mark: number) => until('the CLI to settle the call', async () => (await fakeLog()).slice(mark).find((entry) => entry.settled));
const outputOf = (call: { outputs: Array<{ matcher: string; output: any }> }, matcher: string) =>
  call.outputs.find((entry) => entry.matcher === matcher)?.output;
const spawnOf = async (mark: number) => (await until('the CLI to start', async () => (await fakeLog()).slice(mark).find((entry) => entry.spawn))).spawn as { argv: string[]; tmpdir: string | null; claudeTmpdir: string | null };
const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]) as Record<string, any>;
const eventsOf = (sessionId: string, kind?: string) => pushed.filter((event) => event.sessionId === sessionId && (!kind || event.kind === kind));

test('a bridge-started run hands the CLI Foreman\'s subagents (bashAllow stays behind) and the Bash rule, and there is no guard hook next to it', async () => {
  const { sessionId, mark } = await run('bash|test-runner|npm test');
  const call = await settledCall(mark);
  const initialized = (await fakeLog()).slice(mark).find((entry) => entry.initialized);
  assert.deepEqual(initialized.agents, {
    explorer: { description: 'Searches and reads code.', prompt: 'You are a read-only explorer.', tools: ['Read', 'Grep', 'Glob'], model: 'haiku' },
    'test-runner': { description: 'Runs the tests.', prompt: 'You run verification commands.', tools: ['Bash', 'Read', 'Grep', 'Glob'], model: 'haiku', maxTurns: 20 },
  });
  assert.deepEqual(initialized.initialized, ['Notification', 'PreToolUse']);
  assert.deepEqual(initialized.preToolUseMatchers, ['Bash'], 'the subagent rule alone: the sandbox is not a hook');

  // An allowed command: the rule does not object, and the CLI runs it.
  assert.deepEqual(outputOf(call, 'Bash'), {});
  assert.deepEqual(call.settled, { behavior: 'allow', by: 'cli' });
  await idle(sessionId);
});

test('the sandbox sent with the start reaches the CLI: the SDK sandbox option, the permission rules, the denied tools and the scratch environment', async () => {
  const policy = sandboxPolicy({ permissions: { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)'] }, disallowedTools: ['AskUserQuestion', 'WebFetch'] });
  const { sessionId, mark } = await run('hello', policy);
  const spawn = await spawnOf(mark);
  const settings = settingsOf(spawn.argv);

  // The switches that make it a sandbox are on, whatever the policy said.
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { ...policy.network, strictAllowlist: true },
    filesystem: policy.filesystem,
    credentials: policy.credentials,
  });
  assert.deepEqual(settings.permissions.allow, policy.permissions.allow);
  assert.deepEqual(settings.permissions.deny, policy.permissions.deny);
  assert.deepEqual(spawn.argv[spawn.argv.indexOf('--disallowedTools') + 1].split(/[ ,]+/).sort(), ['AskUserQuestion', 'ExitPlanMode', 'WebFetch']);
  assert.equal(spawn.tmpdir, `${scratchDir}/tmp`);
  assert.equal(spawn.claudeTmpdir, `${scratchDir}/cc`);
  // The CLI makes <TMPDIR>/claude-<uid> itself but not its parents: the bridge made them before the run.
  for (const made of [scratchDir, `${scratchDir}/tmp`, `${scratchDir}/cc`]) {
    assert.ok((await stat(made)).isDirectory(), made);
  }
  await idle(sessionId);
});

test('a subagent command off its list is denied by the rule, and nobody is asked about it', async () => {
  const { sessionId, mark } = await run('bash|test-runner|npm test; rm -rf x');
  const call = await settledCall(mark);
  assert.equal(call.agentType, 'test-runner');
  const rule = outputOf(call, 'Bash').hookSpecificOutput;
  assert.equal(rule.permissionDecision, 'deny');
  assert.match(rule.permissionDecisionReason, /^test-runner may only run /);
  assert.deepEqual(call.settled, { behavior: 'deny', by: 'hook' });

  await idle(sessionId);
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
  assert.deepEqual(eventsOf(sessionId, 'permission_request'), [], 'a denied call asks nobody and reports nothing to answer');
});

test('a subagent\'s call that no rule settles is held as a prompt for Foreman, which answers it like any worker\'s', async () => {
  const { sessionId, mark } = await run('ask|explorer|Read|.env');
  const pending = await until('the pending permission', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(pending[0].toolName, 'Read');
  assert.equal(pending[0].input, path.join(projectDir, '.env'));

  // The same prompt reaches Foreman as an event, stored with the session's next sequence number and pushed.
  const event = await until('the permission_request event', () => eventsOf(sessionId, 'permission_request')[0]);
  assert.equal(event.payload.requestId, pending[0].requestId);
  assert.equal(event.payload.tool, 'Read');
  assert.ok(String(event.payload.detail).endsWith('.env'));
  assert.equal(event.id, `${sessionId}:${event.sequence}`);
  const stored = (await api('GET', `/sessions/${sessionId}/events`)).body.data.events as PushedEvent[];
  assert.deepEqual(stored.map((entry) => entry.id), [event.id]);
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/state`)).body.data, { sessionId, status: 'running', lastSequence: 1, supervision: 'started' });

  const answer = { requestId: pending[0].requestId, decision: 'deny', reason: 'Secrets stay out of subagents too.', idempotencyKey: `answer-${sessionId}` };
  const denied = await api('POST', `/sessions/${sessionId}/permission`, answer);
  assert.deepEqual(denied.body.data, { resolved: true });
  // A retry of the same answer (Foreman did not see the first one arrive) is answered from the key, not with a 404.
  assert.deepEqual((await api('POST', `/sessions/${sessionId}/permission`, answer)).body.data, { resolved: true });

  const call = await settledCall(mark);
  assert.equal(call.agentType, 'explorer');
  assert.equal(call.settled.behavior, 'deny');
  assert.equal(call.settled.message, 'Secrets stay out of subagents too.');
  await idle(sessionId);
});

test('AskUserQuestion is refused at once in a sandboxed run: nobody is asked, nothing is stored to answer', async () => {
  const { sessionId, mark } = await run('ask||AskUserQuestion|Which store?');
  const call = await settledCall(mark);
  assert.equal(call.settled.behavior, 'deny');
  assert.match(call.settled.message, /^No person is available to answer this tool call in this session, because it runs unattended\./);
  await idle(sessionId);
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
  assert.deepEqual(eventsOf(sessionId, 'permission_request'), []);
});

test('a prompt nobody answers within the sandbox\'s approvalTimeoutMs is denied as a timeout, and the run goes on', async () => {
  const { sessionId, mark } = await run('ask||Read|.env', sandboxPolicy({ approvalTimeoutMs: 1000 }));
  const call = await settledCall(mark);
  assert.equal(call.settled.behavior, 'deny');
  assert.match(call.settled.message, /^Timed out waiting for the supervisor to approve this Read call: no answer within 1 second\(s\)\. This is a timeout, not a decision\./);
  await idle(sessionId);
  // It had been asked (the prompt was reported) and is no longer pending.
  assert.equal(eventsOf(sessionId, 'permission_request').length, 1);
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
});

test('what a run did is stored as numbered events for Foreman and pushed to its intake until acknowledged', async () => {
  const { sessionId } = await run('hello');
  await idle(sessionId);
  const event = await until('the turn_end event', () => eventsOf(sessionId, 'turn_end')[0]);
  assert.equal(event.sequence, 1);
  assert.equal(event.payload.text, 'hello', 'the text of the turn\'s result');
  assert.equal(event.payload.commitCount, 0, 'the project is no repository, so nothing was committed');
  assert.equal(event.payload.headSha, null, 'and it has no HEAD');

  const stored = (await api('GET', `/sessions/${sessionId}/events?after=0`)).body.data;
  assert.deepEqual(stored.events.map((entry: PushedEvent) => [entry.id, entry.kind]), [[`${sessionId}:1`, 'turn_end']]);
  assert.equal(stored.hasMore, false);
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/state`)).body.data, { sessionId, status: 'idle', lastSequence: 1, supervision: 'started' });
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/events?after=1`)).body.data.events, []);
  assert.equal(eventsOf(sessionId).length, 1, 'pushed once: the 2xx acknowledged it');
  assert.deepEqual([...new Set(pushedWith)], [`Bearer ${INTAKE_TOKEN}`], 'the intake got its own token, never the bridge token');
});

/** The owner's grant through the real login: the token cloudcli's own registration hands out. */
async function grantAs(token: string, sessionId: string): Promise<number> {
  const response = await fetch(`${appUrl}/api/foreman-suggestions/handover/${sessionId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return response.status;
}

test('an adopted session runs as its owner set it up: no sandbox, none of the worker\'s subagents and rules, and Foreman still gets its events', async () => {
  const sessionId = createOwnerSession('My own work');
  // The bridge token is no login: it cannot grant, and without the owner's grant Foreman cannot adopt.
  assert.equal(await grantAs(TOKEN, sessionId), 401);
  assert.equal((await api('POST', `/sessions/${sessionId}/adopt`, {})).body.error.code, 'HANDOVER_NOT_GRANTED');
  const registered = await fetch(`${appUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-password' }),
  });
  assert.equal(await grantAs(((await registered.json()) as { token: string }).token, sessionId), 201);

  const mark = (await fakeLog()).length;
  const adopted = await api('POST', `/sessions/${sessionId}/adopt`, {});
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.equal(adopted.body.data.supervision, 'adopted');
  const listed = (await api('GET', '/sessions')).body.data.sessions.find((entry: { id: string }) => entry.id === sessionId);
  assert.deepEqual([listed.sandboxed, listed.supervision], [false, 'adopted']);

  const sent = await api('POST', `/sessions/${sessionId}/message`, { text: 'bash||npm test; rm -rf x' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const call = await settledCall(mark);
  const entries = (await fakeLog()).slice(mark);
  const spawn = entries.find((entry) => entry.spawn).spawn as { argv: string[]; tmpdir: string | null };
  assert.equal(spawn.argv.includes('--settings') && 'sandbox' in settingsOf(spawn.argv), false, 'no sandbox was added');
  assert.equal(spawn.argv.includes('--disallowedTools'), false);
  assert.equal(entries.find((entry) => entry.initialized).agents, null, 'the worker\'s subagents are not handed to the owner\'s session');
  assert.deepEqual(entries.find((entry) => entry.initialized).initialized, ['Notification'], 'and neither is the Bash rule');
  assert.deepEqual(call.settled, { behavior: 'allow', by: 'cli' });

  await idle(sessionId);
  const event = await until('the turn_end event', () => eventsOf(sessionId, 'turn_end')[0]);
  assert.equal(event.sequence, 1);

  // Handed back, it is the owner's alone: Foreman cannot drive it any more.
  assert.equal((await api('POST', `/sessions/${sessionId}/release`, {})).body.data.supervision, 'released');
  const refused = await api('POST', `/sessions/${sessionId}/message`, { text: 'hello again' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'NOT_SUPERVISED');
});

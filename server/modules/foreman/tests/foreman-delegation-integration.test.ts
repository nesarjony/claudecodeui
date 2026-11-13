import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import express from 'express';

/**
 * Milestone 6 end to end inside one process: the real bridge module, database, Claude runtime and SDK, with a fake `claude`
 * executable that plays a subagent's tool call the way Claude Code 2.1.286 does (seen in a real run): every PreToolUse hook
 * whose matcher fits is called with `agent_id` and `agent_type` in its input, a `deny` from any of them settles the call, an
 * `ask` sends it to `can_use_tool` (with `agent_id`), and otherwise the CLI allows it by itself. It also records the `agents`
 * the SDK handed over in its initialize request. Only Foreman's end (runtime config, events) is a stub.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SESSION = 'prov-' + crypto.randomUUID();
const log = process.env.FAKE_CLAUDE_LOG;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const note = (entry) => log && fs.appendFileSync(log, JSON.stringify(entry) + '\n');
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
  // "bash|<agent>|<command>" and "read|<agent>|<file>"; an empty agent is the main worker.
  const [kind, agentType, ...rest] = prompt.split('|');
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
const GUARD = {
  enabled: true,
  riskyPatterns: ['\\bgit\\s+push\\b', 'rm\\s+-[a-z]*r[a-z]*f'],
  secretPatterns: ['(^|[\\s/\'"=])\\.env(?!\\.(example|sample|template)\\b)(\\.[\\w.-]+)?(?=$|[\\s\'"])'],
  writeOutsideRepo: true,
};
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

let directory = '';
let logFile = '';
let projectDir = '';
let baseUrl = '';
let server: http.Server;
let foremanServer: http.Server;
let database: typeof import('@/modules/database/index.js');
const pushed: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
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
  await mkdir(projectDir);
  const cli = path.join(directory, 'fake-claude');
  await writeFile(cli, FAKE_CLAUDE);
  await chmod(cli, 0o755);
  logFile = path.join(directory, 'fake-claude.log');
  await writeFile(logFile, '');
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });

  foremanServer = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url?.endsWith('/foreman/runtime-config')) {
        // No compaction hooks here (no repos), so the PreToolUse matchers a run registers are the subagent rule and the guard.
        response.end(JSON.stringify({ repos: [], workerAutoCompactPct: 70, hooks: { enabled: false, preCompactBudgetMs: 20_000, sessionStartMaxChars: 6000 }, delegation: DELEGATION }));
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/foreman/events')) {
        pushed.push(JSON.parse(body));
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
  setEnv('FOREMAN_EVENTS_URL', `http://127.0.0.1:${(foremanServer.address() as AddressInfo).port}/foreman/events`);
  setEnv('CLOUDCLI_ANTHROPIC_API_KEY_FILE', path.join(directory, 'no-key'));

  database = await import('@/modules/database/index.js');
  database.closeConnection();
  await database.initializeDatabase();
  database.projectsDb.createProjectPath(projectDir);

  const { createForemanModule } = await import('@/modules/foreman/index.js');
  const app = express();
  app.use(express.json());
  app.use('/api/foreman', createForemanModule());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => foremanServer.close(() => resolve()));
  database.closeConnection();
  restore.forEach((undo) => undo());
  await rm(directory, { recursive: true, force: true });
});

async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

async function run(prompt: string, guarded: boolean): Promise<{ sessionId: string; mark: number }> {
  const mark = (await fakeLog()).length;
  const started = await api('POST', '/sessions', {
    projectPath: projectDir,
    prompt,
    billing: 'subscription',
    permissionMode: 'default',
    ...(guarded ? { guard: { ...GUARD, repoRoot: projectDir } } : {}),
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return { sessionId: started.body.data.sessionId as string, mark };
}

const settledCall = (mark: number) => until('the CLI to settle the subagent call', async () => (await fakeLog()).slice(mark).find((entry) => entry.settled));
const outputOf = (call: { outputs: Array<{ matcher: string; output: any }> }, matcher: string) =>
  call.outputs.find((entry) => entry.matcher === matcher)?.output;

test('a bridge-started run hands the CLI Foreman\'s subagents (bashAllow stays behind) and the Bash rule next to the guard', async () => {
  const { sessionId, mark } = await run('bash|test-runner|npm test', true);
  const call = await settledCall(mark);
  const initialized = (await fakeLog()).slice(mark).find((entry) => entry.initialized);
  assert.deepEqual(initialized.agents, {
    explorer: { description: 'Searches and reads code.', prompt: 'You are a read-only explorer.', tools: ['Read', 'Grep', 'Glob'], model: 'haiku' },
    'test-runner': { description: 'Runs the tests.', prompt: 'You run verification commands.', tools: ['Bash', 'Read', 'Grep', 'Glob'], model: 'haiku', maxTurns: 20 },
  });
  assert.deepEqual(initialized.initialized, ['Notification', 'PreToolUse']);
  assert.deepEqual([...initialized.preToolUseMatchers].sort(), ['', 'Bash'], 'the guard (every tool) and the subagent rule (Bash)');

  // An allowed command: neither hook objects, and the CLI runs it.
  assert.deepEqual(outputOf(call, 'Bash'), {});
  assert.deepEqual(outputOf(call, ''), {});
  assert.deepEqual(call.settled, { behavior: 'allow', by: 'cli' });
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
});

test('a subagent command off its list is denied by the rule, and the guard still sees the same call', async () => {
  const eventsBefore = pushed.filter((entry) => entry.type === 'permission_request').length;
  const { sessionId, mark } = await run('bash|test-runner|npm test; rm -rf x', true);
  const call = await settledCall(mark);
  assert.equal(call.agentType, 'test-runner');
  const rule = outputOf(call, 'Bash').hookSpecificOutput;
  assert.equal(rule.permissionDecision, 'deny');
  assert.match(rule.permissionDecisionReason, /^test-runner may only run /);
  // The guard's hook ran on the subagent's call too and held it (agent_id / agent_type change nothing for it).
  const guard = outputOf(call, '').hookSpecificOutput;
  assert.equal(guard.permissionDecision, 'ask');
  assert.match(guard.permissionDecisionReason, /a risky command/);
  assert.deepEqual(call.settled, { behavior: 'deny', by: 'hook' });

  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
  assert.equal(pushed.filter((entry) => entry.type === 'permission_request').length, eventsBefore, 'a denied call asks nobody');
});

test('a subagent\'s read of .env goes through the guard to canUseTool and is held for a person, like the main worker\'s', async () => {
  const eventsBefore = pushed.length;
  const { sessionId, mark } = await run('read|explorer|.env', true);
  const pending = await until('the pending permission', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(pending[0].toolName, 'Read');
  assert.equal(pending[0].input, path.join(projectDir, '.env'));
  const event = await until('the permission_request event', () => pushed.slice(eventsBefore).find((entry) => entry.type === 'permission_request' && entry.sessionId === sessionId));
  assert.equal(event.data.guarded, true);
  assert.equal(event.data.category, 'secret');

  const denied = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'deny', reason: 'Secrets stay out of subagents too.' });
  assert.deepEqual(denied.body.data, { resolved: true });
  const call = await settledCall(mark);
  assert.equal(call.agentType, 'explorer');
  assert.equal(outputOf(call, 'Bash'), undefined, 'the Bash rule is not asked about a Read');
  assert.equal(outputOf(call, '').hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(call.settled.behavior, 'deny');
  assert.equal(call.settled.message, 'Secrets stay out of subagents too.');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
});

test('without a guard the rule still holds subagents to their list, and the main worker\'s own Bash is left alone', async () => {
  const sub = await run('bash|test-runner|git push origin main', false);
  const denied = await settledCall(sub.mark);
  assert.deepEqual((await fakeLog()).slice(sub.mark).find((entry) => entry.initialized).preToolUseMatchers, ['Bash']);
  assert.equal(outputOf(denied, 'Bash').hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(denied.settled, { behavior: 'deny', by: 'hook' });
  await until('the session to be idle', async () => (await statusOf(sub.sessionId)) === 'idle');

  const main = await run('bash||npm test; echo done', false);
  const untouched = await settledCall(main.mark);
  assert.equal(untouched.agentType, null);
  assert.deepEqual(outputOf(untouched, 'Bash'), {});
  assert.deepEqual(untouched.settled, { behavior: 'allow', by: 'cli' });
  await until('the session to be idle', async () => (await statusOf(main.sessionId)) === 'idle');
});

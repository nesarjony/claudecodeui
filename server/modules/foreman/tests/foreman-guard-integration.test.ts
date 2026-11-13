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
 * The guard end to end inside one process: the real bridge module (router, sessions service, state service, event
 * pusher), the real database, the real Claude runtime and the real SDK, with a fake `claude` executable that asks for
 * permission to run `git push` ("risky", or "slow" for a prompt nobody answers) or `git status` ("safe"). Like the real CLI it
 * also runs the PreToolUse hook the SDK registered (a hook_callback control request) before a read-only call, and only
 * asks when the hook says 'ask'; with no hook it allows the call by itself, which is the gap the guard hook closes. Only Foreman's end of the event push is a stub.
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
let asking = null;
let hookIds = [];
let pendingHook = null;
const finish = (text) => {
  out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }, user_message_uuid: userUuid, ...common() });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: text, stop_reason: 'end_turn', total_cost_usd: 0.01, usage, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } }, permission_denials: [], user_message_uuid: userUuid, ...common() });
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'initialize') {
      // Like the CLI: keep the callback ids the SDK registered for PreToolUse.
      hookIds = ((msg.request.hooks || {}).PreToolUse || []).flatMap((matcher) => matcher.hookCallbackIds);
      note({ initialized: Object.keys(msg.request.hooks || {}).sort() });
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: msg.request.subtype === 'initialize' ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {} } });
    return;
  }
  if (msg.type === 'control_response') {
    if (pendingHook && msg.response.request_id === pendingHook.requestId) {
      // The SDK answered the CLI's hook_callback. 'ask' sends the call down the prompt path (can_use_tool); anything else
      // leaves the CLI to settle it by itself, which for these read-only calls means allowing it without asking anyone.
      const hook = pendingHook;
      pendingHook = null;
      const output = msg.response.response || {};
      note({ hook: hook.label, output });
      if (output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision === 'ask') {
        asking = hook.label;
        out({ type: 'control_request', request_id: 'perm-' + crypto.randomUUID(), request: { subtype: 'can_use_tool', tool_name: hook.tool, input: hook.input, tool_use_id: 'tu_h' } });
      } else {
        note({ autoAllowed: hook.label });
        finish('done');
      }
      return;
    }
    if (asking) {
      note({ tool: asking, answer: msg.response.response });
      asking = null;
      finish('done');
    }
    return;
  }
  if (msg.type !== 'user') return;
  userUuid = msg.uuid || null;
  const content = msg.message.content;
  const prompt = typeof content === 'string' ? content : (content.find((block) => block.type === 'text') || {}).text || '';
  note({ prompt });
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: 'default', ...common() });
  const cwd = process.cwd();
  const readOnly = {
    readenv: ['Read', { file_path: cwd + '/.env' }],
    readsrc: ['Read', { file_path: cwd + '/src/a.ts' }],
    globenv: ['Glob', { pattern: '**/.env*' }],
    grepenv: ['Grep', { pattern: 'KEY', glob: '.env*' }],
    catenv: ['Bash', { command: 'cat .env' }],
  }[prompt];
  if (readOnly) {
    const [tool, input] = readOnly;
    const label = tool + ' ' + (input.file_path || input.pattern || input.command);
    if (hookIds.length === 0) {
      // No PreToolUse hook registered: the CLI settles a read-only call inside the project by itself.
      note({ hook: null, autoAllowed: label });
      finish('done');
      return;
    }
    pendingHook = { requestId: 'hook-' + crypto.randomUUID(), tool, input, label };
    out({ type: 'control_request', request_id: pendingHook.requestId, request: { subtype: 'hook_callback', callback_id: hookIds[0], tool_use_id: 'tu_h', input: { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd, tool_name: tool, tool_input: input, tool_use_id: 'tu_h' } } });
    return;
  }
  const command = prompt === 'risky' ? 'git push origin main' : prompt === 'slow' ? 'git push origin slow' : prompt === 'safe' ? 'git status' : null;
  if (command) {
    asking = command;
    out({ type: 'control_request', request_id: 'perm-' + crypto.randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, tool_use_id: 'tu_' + crypto.randomUUID() } });
    return;
  }
  finish('hello');
});
rl.on('close', () => process.exit(0));
`;

const TOKEN = 'guard-integration-token';
const GUARD = {
  enabled: true,
  riskyPatterns: ['\\bgit\\s+push\\b', 'rm\\s+-[a-z]*r[a-z]*f'],
  secretPatterns: ['(^|[\\s/\'"=])\\.env(?!\\.(example|sample|template)\\b)(\\.[\\w.-]+)?(?=$|[\\s\'"])'],
  writeOutsideRepo: true,
};

let directory = '';
let logFile = '';
let projectDir = '';
let baseUrl = '';
let server: http.Server;
let eventsServer: http.Server;
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
  directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-guard-int-'));
  projectDir = path.join(directory, 'project');
  await mkdir(projectDir);
  const cli = path.join(directory, 'fake-claude');
  await writeFile(cli, FAKE_CLAUDE);
  await chmod(cli, 0o755);
  logFile = path.join(directory, 'fake-claude.log');
  await writeFile(logFile, '');
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });

  eventsServer = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      // Foreman's other routes (the runtime config the compaction hooks read) are not stubbed here: 404, so those hooks stay off.
      if (request.method !== 'POST' || !request.url?.endsWith('/foreman/events')) {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      pushed.push(JSON.parse(body));
      response.end('{}');
    });
  });
  eventsServer.listen(0, '127.0.0.1');
  await once(eventsServer, 'listening');

  setEnv('CLAUDE_CLI_PATH', cli);
  setEnv('FAKE_CLAUDE_LOG', logFile);
  setEnv('DATABASE_PATH', path.join(directory, 'auth.db'));
  setEnv('FOREMAN_BRIDGE_TOKEN_FILE', tokenFile);
  setEnv('FOREMAN_EVENTS_URL', `http://127.0.0.1:${(eventsServer.address() as AddressInfo).port}/foreman/events`);
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
  await new Promise<void>((resolve) => eventsServer.close(() => resolve()));
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
const answers = async () => (await fakeLog()).filter((entry) => entry.tool);
const statusOf = async (sessionId: string) =>
  ((await api('GET', '/sessions')).body.data.sessions as Array<{ id: string; status: string }>).find((entry) => entry.id === sessionId)?.status;

test('a risky call reaches Foreman as a guarded permission_request, is answered through the bridge, and the run goes on', async () => {
  const started = await api('POST', '/sessions', {
    projectPath: projectDir,
    prompt: 'risky',
    billing: 'subscription',
    permissionMode: 'default',
    taskId: 'task-guard-1',
    guard: { ...GUARD, repoRoot: projectDir },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.data.guarded, true);
  const sessionId = started.body.data.sessionId as string;

  // The prompt shows up as pending, and the session waits.
  const pending = await until('the pending permission', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, 'Bash');
  assert.equal(pending[0].input, 'git push origin main');
  assert.match(pending[0].askedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(await statusOf(sessionId), 'waiting_permission');
  assert.equal(database.foremanSessionStateDb.get(sessionId)?.status, 'waiting_permission');

  // Foreman was told, with the guard's category.
  const event = await until('the permission_request event', () => pushed.find((entry) => entry.type === 'permission_request' && entry.sessionId === sessionId));
  assert.equal(event.data.requestId, pending[0].requestId);
  assert.equal(event.data.toolName, 'Bash');
  assert.equal(event.data.input, 'git push origin main');
  assert.equal(event.data.category, 'command');
  assert.equal(event.data.guarded, true);
  assert.equal(event.data.taskId, 'task-guard-1');

  // Answer through the bridge: deny with a reason.
  const answered = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'deny', reason: 'No pushes in this task.' });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.data, { resolved: true });

  // The run continued: the CLI got the denial with the reason, and the turn ended.
  const reply = await until('the CLI to receive the answer', async () => (await answers()).find((entry) => entry.tool === 'git push origin main'));
  assert.equal(reply.answer.behavior, 'deny');
  assert.equal(reply.answer.message, 'No pushes in this task.');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
  assert.equal(database.foremanSessionStateDb.get(sessionId)?.status, 'idle');
  assert.equal(database.foremanSessionStateDb.get(sessionId)?.permission_mode, 'default');
  assert.ok(JSON.parse(database.foremanSessionStateDb.get(sessionId)?.guard_json ?? 'null'), 'the guard is stored');

  // A second answer finds nothing pending.
  const late = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'allow' });
  assert.equal(late.status, 404);
  assert.equal(late.body.error.code, 'NO_PENDING_PERMISSION');
});

test('a safe call is allowed with no prompt, no event and no waiting, on a started turn and on a resumed one', async () => {
  const eventsBefore = pushed.filter((entry) => entry.type === 'permission_request').length;
  const started = await api('POST', '/sessions', { projectPath: projectDir, prompt: 'safe', billing: 'subscription', guard: { ...GUARD, repoRoot: projectDir } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const sessionId = started.body.data.sessionId as string;

  const first = await until('the first answer', async () => (await answers()).filter((entry) => entry.tool === 'git status')[0]);
  assert.equal(first.answer.behavior, 'allow');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');

  // The next message resumes the session with the same guard: safe goes through, risky is asked about.
  const message = await api('POST', `/sessions/${sessionId}/message`, { text: 'safe' });
  assert.equal(message.status, 202, JSON.stringify(message.body));
  const second = await until('the second answer', async () => (await answers()).filter((entry) => entry.tool === 'git status')[1]);
  assert.equal(second.answer.behavior, 'allow');
  await until('the session to be idle again', async () => (await statusOf(sessionId)) === 'idle');

  assert.equal(pushed.filter((entry) => entry.type === 'permission_request').length, eventsBefore, 'no prompt reached Foreman');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });

  const risky = await api('POST', `/sessions/${sessionId}/message`, { text: 'risky' });
  assert.equal(risky.status, 202, JSON.stringify(risky.body));
  const pending = await until('the pending permission on the resumed run', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(pending[0].input, 'git push origin main');
  const allowed = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'allow' });
  assert.deepEqual(allowed.body.data, { resolved: true });
  const reply = await until('the CLI to receive the allow', async () => (await answers()).find((entry) => entry.tool === 'git push origin main' && entry.answer.behavior === 'allow'));
  assert.ok(reply);
  await until('the session to be idle once more', async () => (await statusOf(sessionId)) === 'idle');
});

test('a session started without a guard asks about everything, as before, and the UI path is untouched', async () => {
  const started = await api('POST', '/sessions', { projectPath: projectDir, prompt: 'safe', billing: 'subscription' });
  assert.equal(started.body.data.guarded, false);
  const sessionId = started.body.data.sessionId as string;
  const pending = await until('the pending permission', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(pending[0].input, 'git status', 'nothing allowed it on the guard\'s behalf');
  const event = await until('the permission_request event', () => pushed.find((entry) => entry.type === 'permission_request' && entry.sessionId === sessionId));
  assert.equal('guarded' in event.data, false);
  assert.equal('category' in event.data, false);
  await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'allow' });
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
});

test('a guarded prompt nobody answers in time is denied as a timeout, the worker is told so, and a late answer is a 404', async () => {
  const started = await api('POST', '/sessions', {
    projectPath: projectDir,
    prompt: 'slow',
    billing: 'subscription',
    permissionMode: 'default',
    guard: { ...GUARD, repoRoot: projectDir, approvalTimeoutMs: 1000 },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.data.guard.approvalTimeoutMs, 1000);
  const sessionId = started.body.data.sessionId as string;

  const pending = await until('the pending permission', async () => {
    const response = await api('GET', `/sessions/${sessionId}/permissions`);
    return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
  });
  assert.equal(await statusOf(sessionId), 'waiting_permission');
  assert.equal(JSON.parse(database.foremanSessionStateDb.get(sessionId)?.guard_json ?? 'null').approvalTimeoutMs, 1000, 'the window is stored with the guard');

  // Nobody answers. After the guard's window (not the runtime's 55 s) the call is denied, and the CLI is told why.
  const reply = await until('the timeout denial', async () => (await answers()).find((entry) => entry.tool === 'git push origin slow'));
  assert.equal(reply.answer.behavior, 'deny');
  assert.match(reply.answer.message, /^Timed out waiting for a person to approve this Bash call: no one answered within 1 second\./);
  assert.match(reply.answer.message, /no person said no/);
  assert.doesNotMatch(reply.answer.message, /denied by|refused|user denied/i);

  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });

  // The person answers too late: nothing is pending any more.
  const late = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'allow' });
  assert.equal(late.status, 404);
  assert.equal(late.body.error.code, 'NO_PENDING_PERMISSION');
});

// ---------------------------------------------------------------------------------------------
// The PreToolUse hook: reads the CLI would allow by itself are held for a person too
// ---------------------------------------------------------------------------------------------

async function startSession(prompt: string, guarded: boolean): Promise<string> {
  const started = await api('POST', '/sessions', {
    projectPath: projectDir,
    prompt,
    billing: 'subscription',
    permissionMode: 'default',
    ...(guarded ? { guard: { ...GUARD, repoRoot: projectDir } } : {}),
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return started.body.data.sessionId as string;
}

const pendingOf = (sessionId: string) => until('the pending permission', async () => {
  const response = await api('GET', `/sessions/${sessionId}/permissions`);
  return response.body.data.permissions.length > 0 ? response.body.data.permissions : null;
});

test('a guarded session registers the guard hook next to the run\'s own hooks', async () => {
  const mark = (await fakeLog()).length;
  const sessionId = await startSession('safe', true);
  const first = await until('the first answer', async () => (await answers()).filter((entry) => entry.tool === 'git status').at(-1));
  assert.equal(first.answer.behavior, 'allow');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  const registered = (await fakeLog()).slice(mark).find((entry) => entry.initialized);
  assert.deepEqual(registered.initialized, ['Notification', 'PreToolUse']);
});

test('a Read of .env goes through the hook and is held for a person, though the CLI would have allowed it', async () => {
  const mark = (await fakeLog()).length;
  const eventsBefore = pushed.length;
  const sessionId = await startSession('readenv', true);

  const pending = await pendingOf(sessionId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, 'Read');
  assert.equal(pending[0].input, path.join(projectDir, '.env'));
  assert.equal(await statusOf(sessionId), 'waiting_permission');

  // The hook saw the call and asked; the reason names the rule.
  const hook = (await fakeLog()).slice(mark).find((entry) => entry.hook);
  assert.equal(hook.hook, `Read ${path.join(projectDir, '.env')}`);
  assert.equal(hook.output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hook.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(hook.output.hookSpecificOutput.permissionDecisionReason, /a secret or credential path/);

  // Foreman is told, as for any guarded prompt.
  const event = await until('the permission_request event', () => pushed.slice(eventsBefore).find((entry) => entry.type === 'permission_request' && entry.sessionId === sessionId));
  assert.equal(event.data.toolName, 'Read');
  assert.equal(event.data.category, 'secret');
  assert.equal(event.data.guarded, true);
  assert.equal(event.data.requestId, pending[0].requestId);

  const denied = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'deny', reason: 'Secrets stay out of the worker.' });
  assert.deepEqual(denied.body.data, { resolved: true });
  const reply = await until('the CLI to receive the denial', async () => (await fakeLog()).slice(mark).find((entry) => entry.tool && entry.tool.startsWith('Read ')));
  assert.equal(reply.answer.behavior, 'deny');
  assert.equal(reply.answer.message, 'Secrets stay out of the worker.');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
});

test('Glob, Grep and a shell read that name a secret file are held too, and a person can allow them', async () => {
  for (const [prompt, toolName, input] of [
    ['globenv', 'Glob', '**/.env*'],
    ['grepenv', 'Grep', 'KEY'],
    ['catenv', 'Bash', 'cat .env'],
  ] as const) {
    const mark = (await fakeLog()).length;
    const sessionId = await startSession(prompt, true);
    const pending = await pendingOf(sessionId);
    assert.equal(pending[0].toolName, toolName, prompt);
    assert.equal(pending[0].input, input, prompt);
    const hook = (await fakeLog()).slice(mark).find((entry) => entry.hook);
    assert.equal(hook.output.hookSpecificOutput.permissionDecision, 'ask', prompt);

    const allowed = await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'allow' });
    assert.deepEqual(allowed.body.data, { resolved: true }, prompt);
    const reply = await until('the CLI to receive the allow', async () => (await fakeLog()).slice(mark).find((entry) => entry.tool && entry.answer));
    assert.equal(reply.answer.behavior, 'allow', prompt);
    await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  }
});

test('a safe read goes through the hook without being held: the hook answers nothing and nobody is asked', async () => {
  const mark = (await fakeLog()).length;
  const eventsBefore = pushed.filter((entry) => entry.type === 'permission_request').length;
  const sessionId = await startSession('readsrc', true);

  const settled = await until('the CLI to settle the call', async () => (await fakeLog()).slice(mark).find((entry) => entry.autoAllowed));
  assert.equal(settled.autoAllowed, `Read ${path.join(projectDir, 'src', 'a.ts')}`);
  const hook = (await fakeLog()).slice(mark).find((entry) => entry.hook);
  assert.deepEqual(hook.output, {}, 'the hook never allows by itself');
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
  assert.equal(pushed.filter((entry) => entry.type === 'permission_request').length, eventsBefore);
});

test('a session without a guard has no guard hook: the CLI settles the read of .env by itself, as before', async () => {
  const mark = (await fakeLog()).length;
  const sessionId = await startSession('readenv', false);
  const settled = await until('the CLI to settle the call', async () => (await fakeLog()).slice(mark).find((entry) => entry.autoAllowed));
  assert.equal(settled.autoAllowed, `Read ${path.join(projectDir, '.env')}`);
  assert.deepEqual((await fakeLog()).slice(mark).find((entry) => entry.initialized)?.initialized, ['Notification']);
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  assert.deepEqual((await api('GET', `/sessions/${sessionId}/permissions`)).body.data, { permissions: [] });
});

test('a resumed guarded session registers the hook again', async () => {
  const sessionId = await startSession('safe', true);
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
  const mark = (await fakeLog()).length;
  const message = await api('POST', `/sessions/${sessionId}/message`, { text: 'readenv' });
  assert.equal(message.status, 202, JSON.stringify(message.body));
  const pending = await pendingOf(sessionId);
  assert.equal(pending[0].toolName, 'Read');
  assert.deepEqual((await fakeLog()).slice(mark).find((entry) => entry.initialized)?.initialized, ['Notification', 'PreToolUse']);
  await api('POST', `/sessions/${sessionId}/permission`, { requestId: pending[0].requestId, decision: 'deny' });
  await until('the session to be idle', async () => (await statusOf(sessionId)) === 'idle');
});

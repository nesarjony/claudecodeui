import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createBridgeAuthMiddleware } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanIdempotency } from '@/modules/foreman/foreman-idempotency.service.js';
import { resolveContextWindow, type LiveContextUsage } from '@/modules/foreman/foreman-session-reads.service.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';

import { createBridgeServices, createMemoryIdempotencyStorage, createWorld, row, startBody, TOKEN, withBridge } from './foreman-routes-support.js';

// ---------------------------------------------------------------------------------------------
// Auth on the routes
// ---------------------------------------------------------------------------------------------

test('every route demands the bridge token, and the user login is not involved', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/health'],
      ['GET', '/sessions'],
      ['POST', '/sessions', startBody()],
      ['GET', '/sessions/s1/digest'],
      ['GET', '/sessions/s1/context'],
      ['GET', '/sessions/s1/state'],
      ['GET', '/sessions/s1/events'],
      ['POST', '/sessions/s1/adopt', {}],
      ['POST', '/sessions/s1/release', {}],
      ['POST', '/sessions/s1/message', { text: 'hi' }],
      ['POST', '/sessions/s1/interrupt', {}],
      ['POST', '/sessions/s1/model', { model: 'sonnet' }],
      ['POST', '/sessions/s1/compact', {}],
      ['GET', '/sessions/s1/permissions'],
      ['POST', '/sessions/s1/permission', { requestId: 'r1', decision: 'allow' }],
      ['GET', '/projects/git?path=%2Fmnt%2Fdev%2Fknown'],
    ];
    for (const [method, pathname, body] of requests) {
      const missing = await call(method, pathname, body, null);
      assert.equal(missing.status, 401, `${method} ${pathname} without a token`);
      assert.equal(missing.body.error.code, 'FOREMAN_BRIDGE_UNAUTHORIZED');
      const wrong = await call(method, pathname, body, 'wrong');
      assert.equal(wrong.status, 401, `${method} ${pathname} with a wrong token`);
    }
    assert.equal(world.startedTurns.length, 0);
    assert.equal(world.created.length, 0);
    assert.equal(world.idempotencyStorage.rows.size, 0, 'a call without the token claims no idempotency key');
    assert.equal(world.state.get('s1')?.supervision, 'started', 'and changes no supervision');

    const health = await call('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');
  });
});

test('with the token file removed every route answers 503', async () => {
  await withBridge(async ({ call, tokenFile }) => {
    await rm(tokenFile);
    for (const [method, pathname] of [['GET', '/sessions'], ['POST', '/sessions/s1/interrupt']] as const) {
      const response = await call(method, pathname, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, 'FOREMAN_BRIDGE_DISABLED');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GET /sessions
// ---------------------------------------------------------------------------------------------

test('GET /sessions lists claude sessions with status, billing, activity and background task counts', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('running', row({ session_id: 'running', model: 'claude-sonnet-5-5@api', custom_name: 'Build the API', updated_at: '2026-11-13T09:30:00.000Z' }));
    world.rows.set('waiting', row({ session_id: 'waiting', model: 'opus', updated_at: '2026-11-13T09:20:00.000Z' }));
    world.rows.set('broken', row({ session_id: 'broken', updated_at: '2026-11-13T09:10:00.000Z' }));
    world.rows.set('idle', row({ session_id: 'idle', model: 'sonnet@api', project_path: '/mnt/dev/other', updated_at: '2026-11-13T09:00:00.000Z' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    world.rows.set('old-but-live', row({ session_id: 'old-but-live', updated_at: '2020-01-01T00:00:00.000Z' }));
    world.processing.add('running');
    world.live.add('running');
    world.background.set('running', [{ ambient: false }, { ambient: false }, { ambient: true }]);
    world.approvals.set('waiting', [{ requestId: 'r1' }]);
    world.live.add('waiting');
    world.state.setStatus('broken', 'error');
    world.live.add('old-but-live');

    const response = await call('GET', '/sessions?limit=4');
    assert.equal(response.status, 200);
    const sessions = response.body.data.sessions as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(sessions.map((session) => [session.id as string, session]));

    // Codex sessions are not the bridge's business; a live session older than the page is still listed.
    assert.equal(byId.codex, undefined);
    assert.ok(byId['old-but-live']);

    assert.deepEqual(byId.running, {
      id: 'running',
      taskId: null,
      projectPath: '/mnt/dev/known',
      title: 'Build the API',
      model: 'claude-sonnet-5-5',
      billing: 'api-key',
      status: 'running',
      permissionMode: null,
      sandboxed: false,
      supervision: 'started',
      live: true,
      lastActivity: '2026-11-13T09:30:00.000Z',
      backgroundTasks: 2,
    });
    assert.equal(byId.waiting.status, 'waiting_permission');
    assert.equal(byId.waiting.billing, 'subscription');
    assert.equal(byId.broken.status, 'error');
    assert.equal(byId.broken.live, false);
    assert.equal(byId.broken.billing, 'subscription');
    assert.equal(byId.broken.model, null);

    // Live sessions first, then most recent.
    assert.equal(sessions[0].live, true);
    const liveCount = sessions.filter((session) => session.live).length;
    assert.ok(sessions.slice(0, liveCount).every((session) => session.live));
  });
});

test('GET /sessions says which sessions Foreman supervises and which sit in a sandbox', async () => {
  await withBridge(async ({ call, world }) => {
    world.addOwnerSession('owner');
    world.addOwnerSession('handed-over');
    world.addOwnerSession('given-back');
    assert.equal((await call('POST', '/sessions/handed-over/adopt', {})).status, 200);
    assert.equal((await call('POST', '/sessions/given-back/adopt', {})).status, 200);
    assert.equal((await call('POST', '/sessions/given-back/release', {})).status, 200);
    const started = await call('POST', '/sessions', startBody());
    assert.equal(started.status, 201);

    const listed = (await call('GET', '/sessions')).body.data.sessions as Array<{ id: string; supervision: string | null; sandboxed: boolean }>;
    const byId = Object.fromEntries(listed.map((session) => [session.id, [session.supervision, session.sandboxed]]));
    assert.deepEqual(byId, {
      owner: [null, false],
      'handed-over': ['adopted', false],
      'given-back': ['released', false],
      [started.body.data.sessionId]: ['started', true],
    });
  });
});

test('GET /sessions can be filtered by project and validates its limit', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('a', row({ session_id: 'a', project_path: '/mnt/dev/known' }));
    world.rows.set('b', row({ session_id: 'b', project_path: '/mnt/dev/other' }));

    const filtered = await call('GET', `/sessions?projectPath=${encodeURIComponent('/mnt/dev/other/')}`);
    assert.deepEqual(filtered.body.data.sessions.map((session: { id: string }) => session.id), ['b']);

    for (const bad of ['0', '101', 'abc', '-1']) {
      const response = await call('GET', `/sessions?limit=${bad}`);
      assert.equal(response.status, 400, `limit=${bad}`);
      assert.equal(response.body.success, false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GET /sessions/:id/digest
// ---------------------------------------------------------------------------------------------

async function writeTranscript(root: string, providerId: string, lines: unknown[]): Promise<void> {
  await mkdir(path.join(root, '-mnt-dev-known'), { recursive: true });
  await writeFile(path.join(root, '-mnt-dev-known', `${providerId}.jsonl`), lines.map((entry) => JSON.stringify(entry)).join('\n'));
}

test('GET /sessions/:id/digest returns the condensed turn with the session summary', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', custom_name: 'Fix it', model: 'sonnet@api' }));
    await writeTranscript(world.claudeProjectsRoot, 'prov-s1', [
      { type: 'user', timestamp: '2026-11-13T09:00:00Z', message: { role: 'user', content: 'Fix the bug' } },
      { type: 'assistant', timestamp: '2026-11-13T09:00:05Z', message: { id: 'm1', model: 'sonnet', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } } },
      { type: 'user', timestamp: '2026-11-13T09:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fail', is_error: true }] } },
      { type: 'assistant', timestamp: '2026-11-13T09:00:09Z', message: { id: 'm2', model: 'sonnet', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 3 } } },
    ]);

    const response = await call('GET', '/sessions/s1/digest');
    assert.equal(response.status, 200);
    const { session, digest } = response.body.data;
    assert.equal(session.id, 's1');
    assert.equal(session.billing, 'api-key');
    assert.equal(digest.lastUserMessage, 'Fix the bug');
    assert.equal(digest.finalAssistantText, 'Fixed.');
    assert.equal(digest.stopReason, 'end_turn');
    assert.deepEqual(digest.toolCalls, [{ name: 'Bash', shortInput: 'npm test', isError: true, resultTail: 'fail' }]);
    assert.equal(digest.turnsRequested, 1);

    const two = await call('GET', '/sessions/s1/digest?turns=2');
    assert.equal(two.body.data.digest.turnsRequested, 2);
  });
});

test('GET /sessions/:id/digest validates input and reports missing sessions and transcripts', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));

    assert.equal((await call('GET', '/sessions/s1/digest?turns=0')).status, 400);
    assert.equal((await call('GET', '/sessions/s1/digest?turns=11')).status, 400);
    assert.equal((await call('GET', '/sessions/s1/digest?turns=x')).status, 400);
    assert.equal((await call('GET', '/sessions/bad%20id/digest')).status, 400);

    const missing = await call('GET', '/sessions/nope/digest');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');

    const noTranscript = await call('GET', '/sessions/s1/digest');
    assert.equal(noTranscript.status, 404);
    assert.equal(noTranscript.body.error.code, 'TRANSCRIPT_NOT_FOUND');

    const wrongProvider = await call('GET', '/sessions/codex/digest');
    assert.equal(wrongProvider.status, 400);
    assert.equal(wrongProvider.body.error.code, 'UNSUPPORTED_PROVIDER');
  });
});

// ---------------------------------------------------------------------------------------------
// GET /sessions/:id/context
// ---------------------------------------------------------------------------------------------

const LIVE_USAGE: LiveContextUsage = {
  totalTokens: 90_000,
  maxTokens: 200_000,
  rawMaxTokens: 1_000_000,
  model: 'claude-sonnet-5-5',
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167_000,
  categories: [
    { name: 'Messages', tokens: 60_000, kind: 'used' },
    { name: 'System prompt', tokens: 8_000, kind: 'used' },
    { name: 'Free space', tokens: 110_000, kind: 'free' },
  ],
};

test('GET /sessions/:id/context reports what the live process measures', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-sonnet-5-5' }));
    world.live.add('s1');
    world.liveContext = LIVE_USAGE;

    const response = await call('GET', '/sessions/s1/context');
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.source, 'live');
    assert.equal(data.usedTokens, 90_000);
    assert.equal(data.windowTokens, 200_000);
    assert.equal(data.rawWindowTokens, 1_000_000);
    assert.equal(data.fraction, 0.45);
    assert.equal(data.autoCompactThreshold, 167_000);
    assert.deepEqual(data.categories, [{ name: 'Messages', tokens: 60_000 }, { name: 'System prompt', tokens: 8_000 }]);
  });
});

test('GET /sessions/:id/context estimates from the transcript when no process is live', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-opus-5-5[1m]@api' }));
    await writeTranscript(world.claudeProjectsRoot, 'prov-s1', [
      { type: 'user', timestamp: '2026-11-13T09:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: '2026-11-13T09:00:05Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 399_000, cache_creation_input_tokens: 1_000, output_tokens: 500 } } },
    ]);

    const data = (await call('GET', '/sessions/s1/context')).body.data;
    assert.equal(data.source, 'transcript');
    assert.equal(data.usedTokens, 400_510);
    // The [1m] marker on the session's model means the extended window.
    assert.equal(data.windowTokens, 1_000_000);
    assert.equal(data.model, 'claude-opus-5-5[1m]');
    assert.ok(Math.abs(data.fraction - 0.40051) < 1e-9);
  });
});

test('a live measurement that fails falls back to the transcript and says so', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet' }));
    world.live.add('s1');
    world.liveContext = 'throw';
    await writeTranscript(world.claudeProjectsRoot, 'prov-s1', [
      { type: 'assistant', timestamp: '2026-11-13T09:00:05Z', message: { id: 'm1', model: 'sonnet', content: [], usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);

    const data = (await call('GET', '/sessions/s1/context')).body.data;
    assert.equal(data.source, 'transcript');
    assert.equal(data.usedTokens, 150);
    assert.equal(data.windowTokens, 200_000);
    assert.match(data.note, /Live measurement failed \(control request failed\)/);
  });
});

test('GET /sessions/:id/context is explicit when nothing is known', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    const data = (await call('GET', '/sessions/s1/context')).body.data;
    assert.equal(data.source, 'unknown');
    assert.equal(data.usedTokens, null);
    assert.equal(data.fraction, null);
    assert.equal((await call('GET', '/sessions/nope/context')).status, 404);
  });
});

test('the context window is the extended one for [1m] models and for usage beyond the standard window', () => {
  assert.equal(resolveContextWindow('claude-sonnet-5-5', 50_000), 200_000);
  assert.equal(resolveContextWindow('claude-sonnet-5-5[1m]', 50_000), 1_000_000);
  assert.equal(resolveContextWindow('default', 250_000), 1_000_000);
  assert.equal(resolveContextWindow(null, 0), 200_000);
});


// ---------------------------------------------------------------------------------------------
// Milestone 5: GET /projects/git
// ---------------------------------------------------------------------------------------------

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' },
});

test('GET /projects/git reports a project that is not a repository as isRepo false, not an error', async () => {
  await withBridge(async ({ call, projectDir }) => {
    const response = await call('GET', `/projects/git?path=${encodeURIComponent(projectDir)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data, { path: projectDir, isRepo: false, branch: null, status: '', diffStat: '', diff: '', truncated: false });
  });
});

test('GET /projects/git returns branch, status, diff stat and diff of a repository, including new files', async () => {
  await withBridge(async ({ call, projectDir }) => {
    gitIn(projectDir, 'init', '-q', '-b', 'main');
    await writeFile(path.join(projectDir, 'a.txt'), 'old\n');
    gitIn(projectDir, 'add', '.');
    gitIn(projectDir, 'commit', '-q', '-m', 'init');
    await writeFile(path.join(projectDir, 'a.txt'), 'new\n');
    await writeFile(path.join(projectDir, 'fresh.txt'), 'brand new\n');

    const response = await call('GET', `/projects/git?path=${encodeURIComponent(projectDir)}`);
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['branch', 'diff', 'diffStat', 'isRepo', 'path', 'status', 'truncated']);
    assert.equal(data.isRepo, true);
    assert.equal(data.branch, 'main');
    assert.match(data.status, /^## main/);
    assert.match(data.status, /\?\? fresh\.txt/);
    assert.match(data.diffStat, /a\.txt/);
    assert.match(data.diff, /^-old$/m);
    assert.match(data.diff, /^\+new$/m);
    assert.match(data.diff, /^\+\+\+ b\/fresh\.txt$/m);
    assert.equal(data.truncated, false);

    // A path inside the project works too.
    await mkdir(path.join(projectDir, 'sub'));
    const inside = await call('GET', `/projects/git?path=${encodeURIComponent(path.join(projectDir, 'sub'))}`);
    assert.equal(inside.status, 200);
    assert.equal(inside.body.data.isRepo, true);
  });
});

test('GET /projects/git validates the path: 400 when missing or relative, 422 for an unknown project, 404 when it does not exist', async () => {
  await withBridge(async ({ call, projectDir }) => {
    for (const query of ['', '?path=', '?path=relative%2Fdir', `?path=${encodeURIComponent('x'.repeat(5000))}`, '?path=a&path=b']) {
      const response = await call('GET', `/projects/git${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.success, false);
    }
    for (const unknown of ['/mnt/dev/known', '/', '/etc', `${projectDir}-other`, `${projectDir}/../project-sibling`]) {
      const response = await call('GET', `/projects/git?path=${encodeURIComponent(unknown)}`);
      assert.equal(response.status, 422, unknown);
      assert.equal(response.body.error.code, 'UNKNOWN_PROJECT', unknown);
    }
    const missing = await call('GET', `/projects/git?path=${encodeURIComponent(path.join(projectDir, 'gone'))}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PATH_NOT_FOUND');
  });
});

test('GET /projects/git answers 503 when no git service is wired', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-routes-nogit-'));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const { deps } = createWorld();
  const app = express();
  app.use('/api/foreman', createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    ...createBridgeServices(deps),
    idempotency: createForemanIdempotency({ storage: createMemoryIdempotencyStorage() }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman/projects/git?path=%2Ftmp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'GIT_UNAVAILABLE');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

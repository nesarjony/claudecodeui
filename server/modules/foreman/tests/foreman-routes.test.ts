import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createBridgeAuthMiddleware } from '@/modules/foreman/foreman-auth.service.js';
import {
  createForemanSessionsService,
  resolveContextWindow,
  type ForemanBridgeDependencies,
  type LiveContextUsage,
} from '@/modules/foreman/foreman-sessions.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';

type SessionRow = NonNullable<ReturnType<ForemanBridgeDependencies['sessionsDb']['getSessionById']>>;
type StartTurnInput = Parameters<ForemanBridgeDependencies['startTurn']>[0];
type ProjectRow = NonNullable<ReturnType<ForemanBridgeDependencies['projectsDb']['getProjectPath']>>;

const TOKEN = 'route-test-token';

function row(overrides: Partial<SessionRow> & { session_id: string }): SessionRow {
  return {
    provider: 'claude',
    provider_session_id: `prov-${overrides.session_id}`,
    project_path: '/mnt/dev/known',
    jsonl_path: null,
    custom_name: null,
    model: null,
    effort: null,
    forked_from_session_id: null,
    isArchived: 0,
    created_at: '2026-11-13T08:00:00.000Z',
    updated_at: '2026-11-13T09:00:00.000Z',
    ...overrides,
  };
}

/** A tiny in-memory cloudcli: session rows, runs, a fake Claude runtime, and a turn starter that records its calls. */
function createWorld() {
  const rows = new Map<string, SessionRow>();
  const processing = new Set<string>();
  const live = new Set<string>();
  const approvals = new Map<string, unknown[]>();
  const background = new Map<string, Array<{ ambient?: boolean }>>();
  const failed = new Set<string>();
  const taskStore = new Map<string, string>();

  const world = {
    rows,
    processing,
    live,
    approvals,
    background,
    failed,
    startedTurns: [] as StartTurnInput[],
    aborted: [] as string[],
    completedRuns: [] as Array<{ sessionId: string; exitCode: number; aborted: boolean }>,
    modelChanges: [] as Array<{ sessionId: string; model: string }>,
    liveModelChanges: [] as Array<{ sessionId: string; model: string }>,
    announced: [] as string[],
    created: [] as Array<{ projectPath: string; initialMessage: string }>,
    apiKeyAvailable: true,
    claudeProjectsRoot: '',
    liveContext: null as LiveContextUsage | null | 'throw',
    abortResult: true,
    /** What startTurn resolves with; the default pretends a turn that is still running. */
    turnOutcome: (): Promise<{ started: boolean; error: string | null }> =>
      new Promise((resolve) => setTimeout(() => resolve({ started: true, error: null }), 60)),
    nextId: 1,
  };

  const deps: ForemanBridgeDependencies = {
    sessionsDb: {
      getSessionById: (id) => rows.get(id) ?? null,
      getRecentSessionsPage: (limit, offset) => ({
        sessions: [...rows.values()]
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(offset, offset + limit),
        total: rows.size,
      }),
      updateSessionCustomName: (id, name) => {
        const target = rows.get(id);
        if (target) target.custom_name = name;
      },
    },
    projectsDb: {
      getProjectPath: (projectPath) => {
        if (projectPath === '/mnt/dev/known' || projectPath === '/mnt/dev/other') {
          return { project_id: 'p1', project_path: projectPath, custom_project_name: null, isStarred: 0, isArchived: 0 } as unknown as ProjectRow;
        }
        if (projectPath === '/mnt/dev/archived') {
          return { project_id: 'p2', project_path: projectPath, custom_project_name: null, isStarred: 0, isArchived: 1 } as unknown as ProjectRow;
        }
        return null;
      },
    },
    createAppSession: (projectPath, initialMessage) => {
      world.created.push({ projectPath, initialMessage });
      const id = `new-${world.nextId++}`;
      const name = initialMessage.split(/\s+/).slice(0, 4).join(' ');
      rows.set(id, row({ session_id: id, provider_session_id: null, project_path: projectPath, custom_name: name }));
      return { sessionId: id, sessionName: name };
    },
    startTurn: async (input) => {
      world.startedTurns.push(input);
      // Like the gateway, record the model the turn runs with on the session row.
      const target = rows.get(input.sessionId);
      if (target && typeof input.options.model === 'string') target.model = input.options.model;
      return world.turnOutcome();
    },
    runs: {
      isProcessing: (id) => processing.has(id),
      listRunningSessionIds: () => [...processing],
      completeRun: (sessionId, options) => {
        world.completedRuns.push({ sessionId, ...options });
        processing.delete(sessionId);
      },
    },
    runtime: {
      abort: async (id) => {
        world.aborted.push(id);
        return world.abortResult;
      },
      isLive: (id) => live.has(id),
      liveSessionIds: () => [...live],
      pendingApprovals: (id) => approvals.get(id) ?? [],
      backgroundTasks: (id) => (live.has(id) ? background.get(id) ?? [] : null),
      setModel: async (sessionId, model) => {
        world.liveModelChanges.push({ sessionId, model });
        return true;
      },
      contextUsage: async () => {
        if (world.liveContext === 'throw') throw new Error('control request failed');
        return world.liveContext;
      },
      hasApiKey: () => world.apiKeyAvailable,
    },
    setSessionModel: (sessionId, model) => {
      world.modelChanges.push({ sessionId, model });
      const target = rows.get(sessionId);
      if (target) target.model = model;
    },
    taskIds: createTaskIdStore({
      get: (key) => taskStore.get(key) ?? null,
      set: (key, value) => void taskStore.set(key, value),
    }),
    announceSession: async (sessionId) => {
      world.announced.push(sessionId);
    },
    hasFailed: (id) => failed.has(id),
    admissionWindowMs: 5,
    liveContextTimeoutMs: 200,
  };
  Object.defineProperty(deps, 'claudeProjectsRoot', { get: () => world.claudeProjectsRoot, enumerable: true });

  return { world, deps };
}

type World = ReturnType<typeof createWorld>['world'];

async function withBridge(
  run: (api: {
    baseUrl: string;
    world: World;
    tokenFile: string;
    call: (method: string, pathname: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: any }>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-routes-'));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const { world, deps } = createWorld();
  world.claudeProjectsRoot = path.join(directory, 'projects');
  await mkdir(world.claudeProjectsRoot, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/foreman', createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    sessions: createForemanSessionsService(deps),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, pathname: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${baseUrl}/api/foreman${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ baseUrl, world, tokenFile, call });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Auth on the routes
// ---------------------------------------------------------------------------------------------

test('every route demands the bridge token, and the user login is not involved', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/health'],
      ['GET', '/sessions'],
      ['POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'x' }],
      ['GET', '/sessions/s1/digest'],
      ['GET', '/sessions/s1/context'],
      ['POST', '/sessions/s1/message', { text: 'hi' }],
      ['POST', '/sessions/s1/interrupt', {}],
      ['POST', '/sessions/s1/model', { model: 'sonnet' }],
      ['POST', '/sessions/s1/compact', {}],
    ];
    for (const [method, pathname, body] of requests) {
      const missing = await call(method, pathname, body, null);
      assert.equal(missing.status, 401, `${method} ${pathname} without a token`);
      assert.equal(missing.body.error.code, 'FOREMAN_BRIDGE_UNAUTHORIZED');
      const wrong = await call(method, pathname, body, 'wrong');
      assert.equal(wrong.status, 401, `${method} ${pathname} with a wrong token`);
    }
    assert.equal(world.startedTurns.length, 0);

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
    world.failed.add('broken');
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
// POST /sessions
// ---------------------------------------------------------------------------------------------

test('POST /sessions starts a session through the UI path and returns its id at once', async () => {
  await withBridge(async ({ call, world }) => {
    const response = await call('POST', '/sessions', {
      projectPath: '/mnt/dev/known',
      prompt: 'Implement the login form and run the tests',
      model: 'claude-sonnet-5-5',
      billing: 'api-key',
      permissionMode: 'acceptEdits',
      title: 'Login form',
      taskId: 'task-42',
      effort: 'high',
    });

    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.sessionId, 'new-1');
    assert.deepEqual(
      { projectPath: data.projectPath, title: data.title, model: data.model, billing: data.billing, permissionMode: data.permissionMode, taskId: data.taskId, status: data.status },
      { projectPath: '/mnt/dev/known', title: 'Login form', model: 'claude-sonnet-5-5', billing: 'api-key', permissionMode: 'acceptEdits', taskId: 'task-42', status: 'running' },
    );

    // The same calls the UI makes: allocate the session, then send the first turn with its options.
    assert.deepEqual(world.created, [{ projectPath: '/mnt/dev/known', initialMessage: 'Login form' }]);
    assert.equal(world.startedTurns.length, 1);
    assert.equal(world.startedTurns[0].sessionId, 'new-1');
    assert.equal(world.startedTurns[0].content, 'Implement the login form and run the tests');
    assert.equal(world.startedTurns[0].options.model, 'claude-sonnet-5-5@api');
    assert.equal(world.startedTurns[0].options.permissionMode, 'acceptEdits');
    assert.equal(world.startedTurns[0].options.effort, 'high');
    assert.equal(world.startedTurns[0].interruptActiveRun, undefined);
    assert.deepEqual(world.announced, ['new-1']);
    assert.equal(world.rows.get('new-1')?.custom_name, 'Login form');

    // The task link is remembered for later events and shows in listings.
    const listed = await call('GET', '/sessions');
    assert.equal(listed.body.data.sessions.find((s: { id: string }) => s.id === 'new-1').taskId, 'task-42');
  });
});

test('POST /sessions defaults: api-key billing, default model and permission mode', async () => {
  await withBridge(async ({ call, world }) => {
    const response = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'hello there' });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.billing, 'api-key');
    assert.equal(response.body.data.model, 'default');
    assert.equal(response.body.data.taskId, null);
    assert.equal(world.startedTurns[0].options.model, 'default@api');
    assert.equal(world.startedTurns[0].options.permissionMode, 'default');
  });
});

test('POST /sessions with subscription billing sends the plain model (no @api marker)', async () => {
  await withBridge(async ({ call, world }) => {
    world.apiKeyAvailable = false; // irrelevant for the subscription
    const response = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'hi', model: 'opus@api', billing: 'subscription' });
    assert.equal(response.status, 201);
    assert.equal(world.startedTurns[0].options.model, 'opus');
    assert.equal(response.body.data.billing, 'subscription');
  });
});

test('POST /sessions rejects bad input without starting anything', async () => {
  await withBridge(async ({ call, world }) => {
    const valid = { projectPath: '/mnt/dev/known', prompt: 'do it' };
    const cases: Array<[string, Record<string, unknown>, number, string?]> = [
      ['missing projectPath', { prompt: 'x' }, 400],
      ['relative projectPath', { ...valid, projectPath: 'known' }, 400],
      ['missing prompt', { projectPath: '/mnt/dev/known' }, 400],
      ['blank prompt', { ...valid, prompt: '   ' }, 400],
      ['non-string prompt', { ...valid, prompt: 5 }, 400],
      ['bad billing', { ...valid, billing: 'free' }, 400],
      ['bad permission mode', { ...valid, permissionMode: 'yolo' }, 400],
      ['bad model', { ...valid, model: 'sonnet; rm -rf /' }, 400],
      ['bad effort', { ...valid, effort: 'MAX!' }, 400],
      ['bad task id', { ...valid, taskId: 'has space' }, 400],
      ['unknown project', { ...valid, projectPath: '/mnt/dev/unknown' }, 422, 'UNKNOWN_PROJECT'],
      ['archived project', { ...valid, projectPath: '/mnt/dev/archived' }, 422, 'UNKNOWN_PROJECT'],
    ];
    for (const [name, body, status, code] of cases) {
      const response = await call('POST', '/sessions', body);
      assert.equal(response.status, status, name);
      assert.equal(response.body.success, false, name);
      if (code) assert.equal(response.body.error.code, code, name);
    }
    assert.equal(world.created.length, 0);
    assert.equal(world.startedTurns.length, 0);

  });
});

test('a request body that is not a JSON object is rejected', async () => {
  await withBridge(async ({ baseUrl }) => {
    for (const raw of ['[1,2]', '"text"', '42', 'null']) {
      const response = await fetch(`${baseUrl}/api/foreman/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: raw,
      });
      // express.json() (strict mode) rejects bare primitives itself; arrays reach the route.
      assert.ok(response.status === 400, `${raw} -> ${response.status}`);
    }
  });
});

test('POST /sessions refuses API-key billing when no key file is available', async () => {
  await withBridge(async ({ call, world }) => {
    world.apiKeyAvailable = false;
    const response = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'x', billing: 'api-key' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'API_KEY_UNAVAILABLE');
    assert.equal(world.created.length, 0);
  });
});

test('POST /sessions reports a turn the runtime refuses immediately', async () => {
  await withBridge(async ({ call, world }) => {
    world.turnOutcome = async () => ({ started: false, error: 'Provider "claude" is not available.' });
    const refused = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'x' });
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error.code, 'TURN_START_FAILED');

    world.turnOutcome = async () => { throw new Error('spawn failed'); };
    const crashed = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'x' });
    assert.equal(crashed.status, 502);
    assert.match(crashed.body.error.message, /spawn failed/);

    world.turnOutcome = async () => ({ started: true, error: 'ENOENT: no such file' });
    const failedFast = await call('POST', '/sessions', { projectPath: '/mnt/dev/known', prompt: 'x' });
    assert.equal(failedFast.status, 502);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/message
// ---------------------------------------------------------------------------------------------

test('POST message to an idle session starts a resume turn with the settings the UI would send', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-opus-5-5@api', effort: 'xhigh' }));

    const response = await call('POST', '/sessions/s1/message', { text: 'Now add tests', permissionMode: 'bypassPermissions' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body.data, { sessionId: 's1', accepted: true, interrupted: false });

    assert.equal(world.startedTurns.length, 1);
    const turn = world.startedTurns[0];
    assert.equal(turn.sessionId, 's1');
    assert.equal(turn.content, 'Now add tests');
    assert.equal(turn.interruptActiveRun, false);
    assert.equal(turn.options.model, 'claude-opus-5-5@api');
    assert.equal(turn.options.effort, 'xhigh');
    assert.equal(turn.options.permissionMode, 'bypassPermissions');

    // The permission mode is remembered for the next message.
    await tick();
    await call('POST', '/sessions/s1/message', { text: 'And docs' });
    assert.equal(world.startedTurns[1].options.permissionMode, 'bypassPermissions');
  });
});

test('POST message while a turn runs is refused unless it asks to interrupt', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet' }));
    world.processing.add('s1');

    const refused = await call('POST', '/sessions/s1/message', { text: 'steer' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'RUN_IN_PROGRESS');
    assert.equal(world.startedTurns.length, 0);

    const steered = await call('POST', '/sessions/s1/message', { text: 'steer', interrupt: true });
    assert.equal(steered.status, 202);
    assert.equal(steered.body.data.interrupted, true);
    assert.equal(world.startedTurns[0].interruptActiveRun, true);
  });
});

test('POST message maps a lost admission race to 409', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.turnOutcome = async () => ({ started: false, error: 'A run is already in progress for this session.' });
    const response = await call('POST', '/sessions/s1/message', { text: 'hello' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'RUN_IN_PROGRESS');
  });
});

test('POST message validates the session and the body', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.rows.set('codex', row({ session_id: 'codex', provider: 'codex' }));
    assert.equal((await call('POST', '/sessions/nope/message', { text: 'x' })).status, 404);
    assert.equal((await call('POST', '/sessions/codex/message', { text: 'x' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', {})).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: '  ' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x'.repeat(200_001) })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x', interrupt: 'yes' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x', permissionMode: 'nope' })).status, 400);
    assert.equal(world.startedTurns.length, 0);
  });
});

test('POST message to an idle API-key session needs the key file', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet@api' }));
    world.apiKeyAvailable = false;
    const response = await call('POST', '/sessions/s1/message', { text: 'x' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'API_KEY_UNAVAILABLE');

    // A live process already has its billing; it does not need the key again.
    world.live.add('s1');
    assert.equal((await call('POST', '/sessions/s1/message', { text: 'x' })).status, 202);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/interrupt
// ---------------------------------------------------------------------------------------------

test('POST interrupt stops the run the way the UI Stop button does', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    world.live.add('s1');

    const response = await call('POST', '/sessions/s1/interrupt');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionId: 's1', interrupted: true, wasRunning: true, hadLiveProcess: true });
    assert.deepEqual(world.aborted, ['s1']);
    assert.deepEqual(world.completedRuns, [{ sessionId: 's1', exitCode: 0, aborted: true }]);
  });
});

test('POST interrupt also stops a process held open after its turn, and reports a failed abort', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('held', row({ session_id: 'held' }));
    world.live.add('held');
    const held = await call('POST', '/sessions/held/interrupt');
    assert.equal(held.status, 200);
    assert.equal(held.body.data.wasRunning, false);
    assert.equal(held.body.data.hadLiveProcess, true);

    world.rows.set('stuck', row({ session_id: 'stuck' }));
    world.processing.add('stuck');
    world.abortResult = false;
    const stuck = await call('POST', '/sessions/stuck/interrupt');
    assert.equal(stuck.status, 200);
    assert.equal(stuck.body.data.interrupted, false);
    assert.deepEqual(world.completedRuns.at(-1), { sessionId: 'stuck', exitCode: 1, aborted: true });
  });
});

test('POST interrupt on a session with nothing running is a 409, an unknown session a 404', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('idle', row({ session_id: 'idle' }));
    const idle = await call('POST', '/sessions/idle/interrupt');
    assert.equal(idle.status, 409);
    assert.equal(idle.body.error.code, 'NOT_RUNNING');
    assert.equal(world.aborted.length, 0);
    assert.equal((await call('POST', '/sessions/nope/interrupt')).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/model
// ---------------------------------------------------------------------------------------------

test('POST model on a live session changes the running process and records the model', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'claude-sonnet-5-5@api' }));
    world.live.add('s1');

    const response = await call('POST', '/sessions/s1/model', { model: 'claude-opus-5-5' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionId: 's1', model: 'claude-opus-5-5', billing: 'api-key', applied: 'live' });
    // The live process gets the plain model; the row keeps the session's billing marker.
    assert.deepEqual(world.liveModelChanges, [{ sessionId: 's1', model: 'claude-opus-5-5' }]);
    assert.deepEqual(world.modelChanges, [{ sessionId: 's1', model: 'claude-opus-5-5@api' }]);
  });
});

test('POST model on an idle session takes effect on the next run and keeps the billing mode', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('sub', row({ session_id: 'sub', model: 'sonnet' }));
    const response = await call('POST', '/sessions/sub/model', { model: 'opus@api' });
    assert.equal(response.status, 200);
    // An @api marker in the request cannot change a subscription session's billing.
    assert.deepEqual(response.body.data, { sessionId: 'sub', model: 'opus', billing: 'subscription', applied: 'next_run' });
    assert.deepEqual(world.modelChanges, [{ sessionId: 'sub', model: 'opus' }]);
    assert.equal(world.liveModelChanges.length, 0);
  });
});

test('POST model validates its input', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    assert.equal((await call('POST', '/sessions/s1/model', {})).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: '' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: 'a b' })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/model', { model: 7 })).status, 400);
    assert.equal((await call('POST', '/sessions/nope/model', { model: 'sonnet' })).status, 404);
    assert.equal(world.modelChanges.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /sessions/:id/compact
// ---------------------------------------------------------------------------------------------

test('POST compact sends /compact with the instructions as a user turn', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1', model: 'sonnet@api' }));

    const response = await call('POST', '/sessions/s1/compact', { instructions: 'Keep the task notes and the failing test names.' });
    assert.equal(response.status, 202);
    assert.equal(response.body.data.accepted, true);
    assert.equal(response.body.data.command, '/compact Keep the task notes and the failing test names.');
    assert.equal(world.startedTurns[0].content, '/compact Keep the task notes and the failing test names.');
    assert.equal(world.startedTurns[0].options.model, 'sonnet@api');
  });
});

test('POST compact without instructions sends a bare /compact', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    await call('POST', '/sessions/s1/compact', {});
    await tick();
    await call('POST', '/sessions/s1/compact', { instructions: '   ' });
    assert.deepEqual(world.startedTurns.map((turn) => turn.content), ['/compact', '/compact']);
  });
});

test('POST compact is refused while a turn runs and validates its input', async () => {
  await withBridge(async ({ call, world }) => {
    world.rows.set('s1', row({ session_id: 's1' }));
    world.processing.add('s1');
    const busy = await call('POST', '/sessions/s1/compact', { instructions: 'x' });
    assert.equal(busy.status, 409);
    world.processing.clear();

    assert.equal((await call('POST', '/sessions/s1/compact', { instructions: 5 })).status, 400);
    assert.equal((await call('POST', '/sessions/s1/compact', { instructions: 'x'.repeat(8001) })).status, 400);
    assert.equal((await call('POST', '/sessions/nope/compact', {})).status, 404);
    assert.equal(world.startedTurns.length, 0);
  });
});

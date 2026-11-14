import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import type { ForemanIdempotencyRow } from '@/modules/database/index.js';
import { createBridgeAuthMiddleware } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import { createForemanGitService } from '@/modules/foreman/foreman-git.service.js';
import { createForemanHandoverService, type ForemanHandoverDependencies } from '@/modules/foreman/foreman-handover.service.js';
import { createForemanIdempotency, type ForemanIdempotencyStorage } from '@/modules/foreman/foreman-idempotency.service.js';
import { createForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';
import {
  createForemanSessionReadsService,
  type ForemanSessionReadsDependencies,
  type LiveContextUsage,
} from '@/modules/foreman/foreman-session-reads.service.js';
import { createForemanSessionStateService, type ForemanSessionStateStore } from '@/modules/foreman/foreman-session-state.service.js';
import { createForemanSessionsService, type ForemanSessionsDependencies } from '@/modules/foreman/foreman-sessions.service.js';
import { createForemanSuggestionsClient } from '@/modules/foreman/foreman-suggestions.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import { createForemanUiRouter } from '@/modules/foreman/foreman-ui.routes.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';

import { createMemoryGrants, createMemoryRunModeStore } from './foreman-handover-support.js';
import { createMemoryEventStorage } from './foreman-pipeline-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * Everything the three session services need from cloudcli, in one bag: the reads, the sessions service and the hand-over each take
 * the slice they ask for (`reads` is the one they share, built by `createBridgeServices`).
 */
export type BridgeDependencies = ForemanSessionReadsDependencies & Omit<ForemanSessionsDependencies, 'reads'> & Omit<ForemanHandoverDependencies, 'reads'>;

/** The reads, the sessions service and the hand-over over one set of dependencies, wired as `foreman.module.ts` wires them. */
export function createBridgeServices(deps: BridgeDependencies) {
  const reads = createForemanSessionReadsService(deps);
  return {
    reads,
    sessions: createForemanSessionsService({ ...deps, reads }),
    handover: createForemanHandoverService({ ...deps, reads }),
  };
}

export type SessionRow = NonNullable<ReturnType<BridgeDependencies['sessionsDb']['getSessionById']>>;
export type StartTurnInput = Parameters<BridgeDependencies['startTurn']>[0];
type ProjectRow = NonNullable<ReturnType<BridgeDependencies['projectsDb']['getProjectPath']>>;

export const TOKEN = 'route-test-token';
/** What the fake `headOf` answers: the commit every project is "at". */
export const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

export function row(overrides: Partial<SessionRow> & { session_id: string }): SessionRow {
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

/** The idempotency table in memory. */
export function createMemoryIdempotencyStorage(rows = new Map<string, ForemanIdempotencyRow>()): ForemanIdempotencyStorage & { rows: typeof rows } {
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    begin: (key, operation, fingerprint, createdAt) => void rows.set(key, { key, operation, fingerprint, state: 'pending', status_code: null, response_json: null, created_at: createdAt }),
    complete(key, status, json) {
      const existing = rows.get(key);
      if (existing) rows.set(key, { ...existing, state: 'done', status_code: status, response_json: json });
    },
    release: (key) => void rows.delete(key),
  };
}

/** The session rows of the fake cloudcli: `set` counts as a session Foreman started, `setUntracked` as one its owner owns. */
class SessionRows extends Map<string, SessionRow> {
  constructor(private readonly onStarted: (sessionId: string) => void) {
    super();
  }

  override set(sessionId: string, value: SessionRow): this {
    super.set(sessionId, value);
    this.onStarted(sessionId);
    return this;
  }

  setUntracked(sessionId: string, value: SessionRow): this {
    return super.set(sessionId, value);
  }
}

/** A tiny in-memory cloudcli: session rows, runs, a fake Claude runtime, and a turn starter that records its calls. */
export function createWorld() {
  const processing = new Set<string>();
  const live = new Set<string>();
  const approvals = new Map<string, unknown[]>();
  const background = new Map<string, Array<{ ambient?: boolean }>>();
  const taskStore = new Map<string, string>();
  const managedMarks: string[] = [];
  // The state store is an in-memory map; "restarting" builds a second service over the same map.
  const stateRows = new Map<string, Parameters<ForemanSessionStateStore['upsert']>[0]>();
  const stateStore: ForemanSessionStateStore = {
    get: (id) => stateRows.get(id) ?? null,
    upsert: (stateRow) => void stateRows.set(stateRow.session_id, { ...stateRow }),
    updateStatus: (id, status, updatedAt) => {
      const existing = stateRows.get(id);
      if (existing) stateRows.set(id, { ...existing, status, updated_at: updatedAt });
      return Boolean(existing);
    },
    settleAfterRestart: () => {
      let reset = 0;
      let waitingPermission = 0;
      for (const [id, existing] of stateRows) {
        if (existing.status === 'running' || existing.status === 'waiting_permission') {
          if (existing.status === 'waiting_permission') waitingPermission += 1;
          stateRows.set(id, { ...existing, status: 'idle' });
          reset += 1;
        }
      }
      return { reset, waitingPermission };
    },
    listSupervised: () =>
      [...stateRows.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .flatMap((stateRow) => (stateRow.supervision === 'started' || stateRow.supervision === 'adopted' ? [{ session_id: stateRow.session_id, supervision: stateRow.supervision, task_id: stateRow.task_id }] : [])),
  };
  const eventStorage = createMemoryEventStorage();
  const grants = createMemoryGrants();
  const runModeStore = createMemoryRunModeStore();
  // Records into the table as the module's does from the runtime's events.
  const runModes = createForemanRunModes({ store: runModeStore });

  const rows = new SessionRows((sessionId) => {
    // A row added to the world is a session Foreman started, unless the state already knows it better (an adopted one).
    if (!world.state.get(sessionId)) world.state.track(sessionId, { supervision: 'started' });
  });

  const world = {
    stateStore,
    stateRows,
    state: createForemanSessionStateService({ store: stateStore }),
    events: createForemanEventStore({ storage: eventStorage }),
    eventStorage,
    idempotencyStorage: createMemoryIdempotencyStorage(),
    grantRows: grants.rows,
    runModeRows: runModeStore.rows,
    runModes,
    /** A run of the session started in `permissionMode`, as the runtime reports it: the owner ran their session. */
    ownerRan: (sessionId: string, permissionMode: string) =>
      runModes.observe({ kind: 'run_started', sessionId, projectPath: '/mnt/dev/known', resumed: true, model: null, permissionMode }),
    /** The time the hand-over issues and checks grants at; tests move it. */
    clock: new Date('2026-11-14T09:00:00.000Z'),
    /** Who the fake login puts on the UI routes' requests; null for a request nobody logged in to. */
    loggedIn: { id: 1, username: 'nesar' } as { id?: unknown; username?: unknown } | null,
    resolvedPermissions: [] as Array<{ requestId: string; decision: { allow: boolean; message?: string } }>,
    rows,
    /** A session its owner owns: nothing in the bridge's state, so Foreman neither started nor adopted it. */
    addOwnerSession: (sessionId: string, overrides: Partial<SessionRow> = {}) => {
      rows.setUntracked(sessionId, row({ session_id: sessionId, ...overrides }));
    },
    processing,
    live,
    approvals,
    background,
    startedTurns: [] as StartTurnInput[],
    aborted: [] as string[],
    completedRuns: [] as Array<{ sessionId: string; exitCode: number; aborted: boolean }>,
    modelChanges: [] as Array<{ sessionId: string; model: string }>,
    liveModelChanges: [] as Array<{ sessionId: string; model: string }>,
    announced: [] as string[],
    managedMarks,
    created: [] as Array<{ projectPath: string; initialMessage: string }>,
    apiKeyAvailable: true,
    claudeProjectsRoot: '',
    liveContext: null as LiveContextUsage | null | 'throw',
    abortResult: true,
    /** The commit every project is at; null for a project without one. */
    head: HEAD as string | null,
    headCalls: [] as string[],
    /** How many times the bridge waited for the stored events to settle, and what runs while it waits (tests hook in to see the order). */
    settleCalls: 0,
    onSettle: async (): Promise<void> => undefined,
    /** What startTurn resolves with; the default pretends a turn that is still running. */
    turnOutcome: (): Promise<{ started: boolean; error: string | null }> =>
      new Promise((resolve) => setTimeout(() => resolve({ started: true, error: null }), 60)),
    nextId: 1,
  };

  const deps: BridgeDependencies = {
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
      // Not tracked here: what the bridge records for the session it starts is the service's doing, and is what the tests look at.
      rows.setUntracked(id, row({ session_id: id, provider_session_id: null, project_path: projectPath, custom_name: name }));
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
      resolvePermission: (requestId, decision) => {
        world.resolvedPermissions.push({ requestId, decision });
        // Like the runtime's resolver: the prompt is no longer pending once answered.
        for (const [sessionId, pending] of approvals) {
          approvals.set(sessionId, pending.filter((entry) => (entry as { requestId?: string }).requestId !== requestId));
        }
      },
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
    state: world.state,
    events: world.events,
    headOf: async (projectPath) => {
      world.headCalls.push(projectPath);
      return world.head;
    },
    settleEvents: async () => {
      world.settleCalls += 1;
      await world.onSettle();
    },
    taskIds: createTaskIdStore({
      get: (key) => taskStore.get(key) ?? null,
      set: (key, value) => void taskStore.set(key, value),
    }),
    managed: { mark: (sessionId) => void managedMarks.push(sessionId) },
    grants,
    runModes,
    now: () => world.clock,
    announceSession: async (sessionId) => {
      world.announced.push(sessionId);
    },
    admissionWindowMs: 5,
    liveContextTimeoutMs: 200,
  };
  Object.defineProperty(deps, 'claudeProjectsRoot', { get: () => world.claudeProjectsRoot, enumerable: true });

  return { world, deps };
}

export type World = ReturnType<typeof createWorld>['world'];

export type Call = (method: string, pathname: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: any }>;
type UiCall = (method: string, pathname: string, body?: unknown) => Promise<{ status: number; body: any }>;

// Every POST that changes a session carries an idempotency key; the tests that look at the key itself pass their own.
const SESSION_CHANGING = /^\/sessions(\/[^/?]+\/(message|interrupt|model|compact|permission|adopt|release))?(\?.*)?$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function withBridge(
  run: (api: {
    baseUrl: string;
    world: World;
    tokenFile: string;
    call: Call;
    /** The logged-in UI routes (`/api/foreman-suggestions`), as `world.loggedIn`. */
    ui: UiCall;
    /**
     * The owner hands the session over: a run of theirs in `permissionMode` (the mode adopt takes; null for none), then the logged-in grant
     * through the UI route. Adopt needs both.
     */
    handOver: (sessionId: string, permissionMode?: string | null) => Promise<void>;
    /** A real directory registered as the known project `<projectDir>`; `deps` for building a second ("restarted") service. */
    projectDir: string;
    deps: BridgeDependencies;
  }) => Promise<void>,
): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-routes-')));
  const projectDir = path.join(directory, 'project');
  await mkdir(projectDir);
  const projectRows = [{ project_id: 'git-project', project_path: projectDir, custom_project_name: null, isStarred: 0, isArchived: 0 }];
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const { world, deps } = createWorld();
  world.claudeProjectsRoot = path.join(directory, 'projects');
  await mkdir(world.claudeProjectsRoot, { recursive: true });

  const services = createBridgeServices(deps);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  // Stands in for cloudcli's login (`authenticateToken`): it puts the logged-in user on the request, or nobody.
  app.use('/api/foreman-suggestions', (request, _response, next) => {
    if (world.loggedIn) Object.assign(request, { user: world.loggedIn });
    next();
  }, createForemanUiRouter({
    client: createForemanSuggestionsClient({ tokenFile, baseUrl: 'http://foreman.invalid', fetchImpl: (async () => { throw new Error('Foreman is not part of these tests'); }) as typeof fetch }),
    state: world.state,
    handover: services.handover,
  }));
  app.use('/api/foreman', createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    ...services,
    idempotency: createForemanIdempotency({ storage: world.idempotencyStorage }),
    git: createForemanGitService({
      projectsDb: {
        getProjectPath: (candidate: string) => (projectRows.find((project) => project.project_path === candidate) ?? null) as never,
        getProjectPaths: () => projectRows as never,
      },
    }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let nextKey = 1;
  const call: Call = async (method, pathname, body, token = TOKEN) => {
    // `'idempotencyKey' in body` also holds for `{ idempotencyKey: undefined }`, which is how a test sends none.
    const keyed = method === 'POST' && SESSION_CHANGING.test(pathname) && (body === undefined || (isObject(body) && !('idempotencyKey' in body)));
    const sent = keyed ? { ...(isObject(body) ? body : {}), idempotencyKey: `test-key-${nextKey++}` } : body;
    const response = await fetch(`${baseUrl}/api/foreman${pathname}`, {
      method,
      headers: {
        ...(sent !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: sent !== undefined ? JSON.stringify(sent) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  const ui: UiCall = async (method, pathname, body) => {
    const response = await fetch(`${baseUrl}/api/foreman-suggestions${pathname}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const handOver = async (sessionId: string, permissionMode: string | null = 'default') => {
    if (permissionMode) world.ownerRan(sessionId, permissionMode);
    const granted = await ui('POST', `/handover/${encodeURIComponent(sessionId)}`);
    if (granted.status !== 201) throw new Error(`the grant for ${sessionId} was refused: ${JSON.stringify(granted.body)}`);
  };

  try {
    await run({ baseUrl, world, tokenFile, call, ui, handOver, projectDir, deps });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

export const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid session start (the sandbox is required); `extra` overrides or adds fields. */
export const startBody = (extra: Record<string, unknown> = {}) => ({
  projectPath: '/mnt/dev/known',
  prompt: 'Do the task',
  permissionMode: 'default',
  sandbox: samplePolicy(),
  ...extra,
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createBridgeAuthMiddleware } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import { createForemanIdempotency } from '@/modules/foreman/foreman-idempotency.service.js';
import { createForemanSessionStateService, type ForemanSessionStateStore } from '@/modules/foreman/foreman-session-state.service.js';
import { createForemanSessionsService, type ForemanBridgeDependencies } from '@/modules/foreman/foreman-sessions.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import {
  createForemanWorktreeRegistry,
  createForemanWorktreesService,
  validateWorktreeBranch,
} from '@/modules/foreman/foreman-worktrees.service.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createMemoryEventStorage } from './foreman-pipeline-support.js';
import { createMemoryIdempotencyStorage } from './foreman-routes-support.js';
import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * The worktree endpoints against real git repositories in a temp folder. Only the project registry is a stand-in (cloudcli's
 * own add-project path refuses folders under /tmp, where these repositories live).
 */

const TOKEN = 'worktrees-test-token';
const NOW = '2026-11-13T10:00:00.000Z';

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' },
});
const exists = (candidate: string) => stat(candidate).then(() => true, () => false);
const listedWorktrees = (repo: string) => gitIn(repo, 'worktree', 'list', '--porcelain');

/** The project registry as the Worktrees module's gateway sees it, over an in-memory table. */
function fakeProjects() {
  const rows = new Map<string, ProjectRepositoryRow>();
  let next = 1;
  const add = (projectPath: string, options: { archived?: boolean; name?: string | null } = {}) => {
    const row: ProjectRepositoryRow = {
      project_id: `p${next++}`,
      project_path: projectPath,
      custom_project_name: options.name ?? null,
      isStarred: 0,
      isArchived: options.archived ? 1 : 0,
    };
    rows.set(projectPath, row);
    return row;
  };
  const byId = (projectId: string) => [...rows.values()].find((row) => row.project_id === projectId);
  return {
    rows,
    add,
    gateway: {
      getProjectByPath: (projectPath: string) => rows.get(projectPath) ?? null,
      // Like `createProject`: an active row is a conflict, an archived one is reused.
      createProject: async (input: { projectPath: string; customName: string }) => {
        const existing = rows.get(input.projectPath);
        if (existing && !existing.isArchived) {
          throw new AppError('Project path already exists and is active', { code: 'PROJECT_ALREADY_EXISTS', statusCode: 409 });
        }
        if (existing) {
          return { outcome: 'reactivated_archived' as const, project: { projectId: existing.project_id } };
        }
        return { outcome: 'created' as const, project: { projectId: add(input.projectPath, { name: input.customName }).project_id } };
      },
      restoreProject: (projectId: string) => {
        const row = byId(projectId);
        if (row) row.isArchived = 0;
      },
      archiveProject: async (projectId: string) => {
        const row = byId(projectId);
        if (row) row.isArchived = 1;
      },
    },
  };
}

/** Just enough of cloudcli for `POST /sessions`: the turn starter records the project and pretends the turn runs. */
function sessionsOver(projects: ReturnType<typeof fakeProjects>) {
  const started: string[] = [];
  const stateRows = new Map<string, Parameters<ForemanSessionStateStore['upsert']>[0]>();
  const stateStore: ForemanSessionStateStore = {
    get: (id) => stateRows.get(id) ?? null,
    upsert: (row) => void stateRows.set(row.session_id, { ...row }),
    updateStatus: () => false,
    settleAfterRestart: () => ({ reset: 0, waitingPermission: 0 }),
    listSupervised: () => [],
  };
  const deps: ForemanBridgeDependencies = {
    sessionsDb: {
      getSessionById: () => null,
      getRecentSessionsPage: () => ({ sessions: [], total: 0 }) as never,
      updateSessionCustomName: () => undefined,
    },
    projectsDb: { getProjectPath: (projectPath) => projects.gateway.getProjectByPath(projectPath) },
    createAppSession: (projectPath) => {
      started.push(projectPath);
      return { sessionId: `s${started.length}`, sessionName: 'task' };
    },
    startTurn: () => new Promise((resolve) => setTimeout(() => resolve({ started: true, error: null }), 60)),
    runs: { isProcessing: () => false, listRunningSessionIds: () => [], completeRun: () => undefined },
    runtime: {
      abort: async () => true,
      isLive: () => false,
      liveSessionIds: () => [],
      pendingApprovals: () => [],
      resolvePermission: () => undefined,
      backgroundTasks: () => null,
      setModel: async () => true,
      contextUsage: async () => null,
      hasApiKey: () => true,
    },
    setSessionModel: () => undefined,
    state: createForemanSessionStateService({ store: stateStore }),
    events: createForemanEventStore({ storage: createMemoryEventStorage() }),
    headOf: async (projectPath) => `head-of:${projectPath}`,
    settleEvents: async () => undefined,
    taskIds: createTaskIdStore({ get: () => null, set: () => undefined }),
    announceSession: async () => undefined,
    hasFailed: () => false,
    admissionWindowMs: 5,
  };
  return { service: createForemanSessionsService(deps), started, stateRows };
}

type Call = (method: string, pathname: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: any }>;

async function withWorktrees(
  run: (t: {
    call: Call;
    directory: string;
    repo: string;
    worktreesDir: string;
    projects: ReturnType<typeof fakeProjects>;
    store: Map<string, string>;
    started: string[];
    /** What the bridge remembers about the sessions it started. */
    stateRows: ReturnType<typeof sessionsOver>['stateRows'];
  }) => Promise<void>,
  options: { worktreesDir?: string; wired?: boolean } = {},
): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-worktrees-')));
  const repo = path.join(directory, 'desk');
  await mkdir(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'init');

  const projects = fakeProjects();
  projects.add(repo);
  const store = new Map<string, string>();
  const registry = createForemanWorktreeRegistry({
    get: (key) => store.get(key) ?? null,
    set: (key, value) => void store.set(key, value),
    delete: (key) => void store.delete(key),
  });
  const sessions = sessionsOver(projects);
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });

  const app = express();
  app.use(express.json());
  app.use('/api/foreman', createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    sessions: sessions.service,
    idempotency: createForemanIdempotency({ storage: createMemoryIdempotencyStorage() }),
    ...(options.wired === false ? {} : {
      worktrees: createForemanWorktreesService({ projects: projects.gateway, registry, worktreesDir: options.worktreesDir, now: () => new Date(NOW) }),
    }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman`;
  const call: Call = async (method, pathname, body, token = TOKEN) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ call, directory, repo, worktreesDir: path.join(directory, '.foreman-worktrees'), projects, store, started: sessions.started, stateRows: sessions.stateRows });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

const create = (call: Call, body: Record<string, unknown>) => call('POST', '/projects/worktree', body);
const remove = (call: Call, body: Record<string, unknown>) => call('DELETE', '/projects/worktree', body);

// ---------------------------------------------------------------------------------------------
// POST /projects/worktree
// ---------------------------------------------------------------------------------------------

test('POST /projects/worktree makes the worktree on a new branch from HEAD, records it and registers it as a project', async () => {
  await withWorktrees(async ({ call, repo, worktreesDir, projects, store }) => {
    const head = gitIn(repo, 'rev-parse', 'HEAD').trim();
    const response = await create(call, { projectPath: repo, branch: 'foreman/task-7' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const worktree = path.join(worktreesDir, 'desk-foreman-task-7');
    assert.deepEqual(response.body, {
      success: true,
      data: { path: worktree, branch: 'foreman/task-7', base: 'HEAD', projectPath: repo, created: true, registered: true },
    });

    // A real worktree on the new branch, at the commit the base named.
    assert.match(listedWorktrees(repo), new RegExp(`worktree ${worktree}\\nHEAD ${head}\\nbranch refs/heads/foreman/task-7`));
    assert.equal(gitIn(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'foreman/task-7');
    // The registry entry survives a restart (it lives in app_config), and the project is an active cloudcli project.
    assert.deepEqual(JSON.parse(store.get(`foreman.worktree:${worktree}`)!), { repoPath: repo, branch: 'foreman/task-7', createdAt: NOW });
    assert.equal(projects.rows.get(worktree)?.isArchived, 0);
    assert.equal(projects.rows.get(worktree)?.custom_project_name, 'desk · foreman/task-7');
    // The main checkout is left exactly as it was.
    assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(gitIn(repo, 'status', '--porcelain'), '');
  });
});

test('the same call again returns the existing worktree as it is (200, created false), and re-registers what was lost', async () => {
  await withWorktrees(async ({ call, repo, worktreesDir, projects, store }) => {
    const first = await create(call, { projectPath: repo, branch: 'foreman/task-7' });
    assert.equal(first.status, 201);
    projects.rows.get(first.body.data.path)!.isArchived = 1;

    const again = await create(call, { projectPath: repo, branch: 'foreman/task-7' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.data, {
      path: path.join(worktreesDir, 'desk-foreman-task-7'),
      branch: 'foreman/task-7',
      base: null,
      projectPath: repo,
      created: false,
      registered: true,
    });
    assert.equal(projects.rows.get(again.body.data.path)?.isArchived, 0, 'an archived project row is restored');
    assert.equal(JSON.parse(store.get(`foreman.worktree:${again.body.data.path}`)!).createdAt, NOW);
    assert.equal(listedWorktrees(repo).match(/^worktree /gm)?.length, 2, 'no second worktree');
  });
});

test('an existing branch is checked out as it is; a new branch can start from a named base', async () => {
  await withWorktrees(async ({ call, repo, worktreesDir }) => {
    gitIn(repo, 'branch', 'feature/login');
    await writeFile(path.join(repo, 'b.txt'), 'two\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'second');
    const second = gitIn(repo, 'rev-parse', 'HEAD').trim();
    const first = gitIn(repo, 'rev-parse', 'HEAD~1').trim();

    const existing = await create(call, { projectPath: repo, branch: 'feature/login' });
    assert.equal(existing.status, 201, JSON.stringify(existing.body));
    assert.equal(existing.body.data.base, null);
    assert.equal(existing.body.data.path, path.join(worktreesDir, 'desk-feature-login'));
    assert.equal(gitIn(existing.body.data.path, 'rev-parse', 'HEAD').trim(), first, 'the branch kept its own commit');

    const based = await create(call, { projectPath: repo, branch: 'foreman/from-first', base: first });
    assert.equal(based.status, 201, JSON.stringify(based.body));
    assert.equal(based.body.data.base, first);
    assert.equal(gitIn(based.body.data.path, 'rev-parse', 'HEAD').trim(), first);
    const fromMain = await create(call, { projectPath: repo, branch: 'foreman/from-main', base: 'main' });
    assert.equal(gitIn(fromMain.body.data.path, 'rev-parse', 'HEAD').trim(), second);

    const unknownBase = await create(call, { projectPath: repo, branch: 'foreman/x', base: 'no-such-branch' });
    assert.equal(unknownBase.status, 422);
    assert.equal(unknownBase.body.error.code, 'UNKNOWN_BASE');
    // A branch checked out elsewhere (here: the main checkout) cannot get a second worktree.
    const busy = await create(call, { projectPath: repo, branch: 'main' });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'BRANCH_CHECKED_OUT');
  });
});

test('branch names follow git check-ref-format --branch, with a length cap and no leading "-"; nothing is created for a bad one', async () => {
  await withWorktrees(async ({ call, repo, worktreesDir }) => {
    const bad = [
      '-x', '--force', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'a.', '.a', 'a/.b',
      'a.lock', 'a/b.lock/c', '@', 'a@{b', 'HEAD', 'x'.repeat(121), '\u0001x', 'a\u007fb', '../../etc', 'foreman/../../x',
    ];
    for (const branch of bad) {
      const response = await create(call, { projectPath: repo, branch });
      assert.equal(response.status, 400, JSON.stringify(branch));
      assert.equal(response.body.error.code, 'INVALID_BRANCH', JSON.stringify(branch));
    }
    for (const body of [{ projectPath: repo }, { projectPath: repo, branch: '' }, { projectPath: repo, branch: 7 }]) {
      assert.equal((await create(call, body)).status, 400, JSON.stringify(body));
    }
    const badBase = await create(call, { projectPath: repo, branch: 'ok', base: '--upload-pack=x' });
    assert.equal(badBase.status, 400);
    assert.equal(badBase.body.error.code, 'INVALID_BASE');
    assert.equal(await exists(worktreesDir), false, 'nothing was created');
    assert.equal(listedWorktrees(repo).match(/^worktree /gm)?.length, 1);
  });
  for (const good of ['foreman/task-7', 'release/v1.2.3', 'x'.repeat(120), 'feat/über', 'a-b_c.d']) {
    assert.equal(validateWorktreeBranch(good), good);
  }
});

test('the project must be a known, active cloudcli project that is a git repository', async () => {
  await withWorktrees(async ({ call, directory, projects }) => {
    const unknown = await create(call, { projectPath: path.join(directory, 'elsewhere'), branch: 'foreman/x' });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.code, 'UNKNOWN_PROJECT');

    const archived = path.join(directory, 'old');
    await mkdir(archived);
    gitIn(archived, 'init', '-q', '-b', 'main');
    projects.add(archived, { archived: true });
    const refused = await create(call, { projectPath: archived, branch: 'foreman/x' });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'UNKNOWN_PROJECT');

    const plain = path.join(directory, 'plain');
    await mkdir(plain);
    projects.add(plain);
    const notRepo = await create(call, { projectPath: plain, branch: 'foreman/x' });
    assert.equal(notRepo.status, 422);
    assert.equal(notRepo.body.error.code, 'NOT_A_GIT_REPOSITORY');

    const relative = await create(call, { projectPath: 'desk', branch: 'foreman/x' });
    assert.equal(relative.status, 400);
  });
});

test('FOREMAN_WORKTREES_DIR puts the worktrees elsewhere, and only an absolute one is accepted', async () => {
  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-worktrees-root-')));
  try {
    await withWorktrees(async ({ call, repo }) => {
      const response = await create(call, { projectPath: repo, branch: 'foreman/task-8' });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.path, path.join(elsewhere, 'desk-foreman-task-8'));
      const removed = await remove(call, { path: response.body.data.path });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    }, { worktreesDir: elsewhere });
    await withWorktrees(async ({ call, repo }) => {
      const response = await create(call, { projectPath: repo, branch: 'foreman/task-8' });
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'WORKTREES_DIR_INVALID');
    }, { worktreesDir: 'relative/dir' });
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('a session can start in a registered worktree (POST /sessions accepts it as projectPath), and not before', async () => {
  await withWorktrees(async ({ call, repo, worktreesDir, started, stateRows }) => {
    const worktree = path.join(worktreesDir, 'desk-foreman-task-9');
    // A start always carries its sandbox and the key of the call; the sandbox is scratch space beside the worktree.
    const start = (idempotencyKey: string) => ({
      projectPath: worktree,
      prompt: 'work on task 9',
      billing: 'subscription',
      sandbox: samplePolicy({ scratchDir: path.join(worktreesDir, '.scratch', 'task-9') }),
      idempotencyKey,
    });
    const before = await call('POST', '/sessions', start('start:task-9:1'));
    assert.equal(before.status, 422);
    assert.equal(before.body.error.code, 'UNKNOWN_PROJECT');
    assert.deepEqual(started, [], 'nothing was allocated for a project the bridge does not know');

    assert.equal((await create(call, { projectPath: repo, branch: 'foreman/task-9' })).status, 201);
    // The first try was refused, so its key is free: the same call now runs.
    const after = await call('POST', '/sessions', start('start:task-9:1'));
    assert.equal(after.status, 201, JSON.stringify(after.body));
    assert.equal(after.body.data.projectPath, worktree);
    assert.equal(after.body.data.sandboxed, true);
    assert.deepEqual(started, [worktree]);

    // Its commits are counted from the worktree's own head, under the sandbox that was sent.
    const stored = stateRows.get(after.body.data.sessionId);
    assert.equal(stored?.base_head, `head-of:${worktree}`);
    assert.equal(stored?.supervision, 'started');
    assert.deepEqual(JSON.parse(stored?.sandbox_json ?? 'null'), start('x').sandbox);
  });
});

// ---------------------------------------------------------------------------------------------
// DELETE /projects/worktree
// ---------------------------------------------------------------------------------------------

test('DELETE removes a clean worktree, prunes, archives its project, forgets it, and keeps the branch unless asked', async () => {
  await withWorktrees(async ({ call, repo, projects, store }) => {
    const { path: worktree } = (await create(call, { projectPath: repo, branch: 'foreman/task-7' })).body.data;
    const response = await remove(call, { path: worktree });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { success: true, data: { removed: true, path: worktree, branchDeleted: false } });

    assert.equal(await exists(worktree), false);
    assert.doesNotMatch(listedWorktrees(repo), /foreman\/task-7/);
    assert.equal(store.has(`foreman.worktree:${worktree}`), false);
    assert.equal(projects.rows.get(worktree)?.isArchived, 1, 'archived, so its sessions stay readable');
    assert.equal(gitIn(repo, 'branch', '--list', 'foreman/task-7').trim(), 'foreman/task-7');

    // Gone from the registry: a second delete is a 404.
    const again = await remove(call, { path: worktree });
    assert.equal(again.status, 404);
    assert.equal(again.body.error.code, 'NOT_A_FOREMAN_WORKTREE');

    // Making it again reuses the branch and restores the archived project.
    const recreated = await create(call, { projectPath: repo, branch: 'foreman/task-7' });
    assert.equal(recreated.status, 201);
    assert.equal(projects.rows.get(worktree)?.isArchived, 0);
  });
});

test('DELETE with deleteBranch deletes a merged branch with -d, but keeps unmerged work unless forced', async () => {
  await withWorktrees(async ({ call, repo }) => {
    const merged = (await create(call, { projectPath: repo, branch: 'foreman/merged' })).body.data.path;
    const deleted = await remove(call, { path: merged, deleteBranch: true });
    assert.deepEqual(deleted.body.data, { removed: true, path: merged, branchDeleted: true });
    assert.equal(gitIn(repo, 'branch', '--list', 'foreman/merged'), '');

    const unmerged = (await create(call, { projectPath: repo, branch: 'foreman/unmerged' })).body.data.path;
    await writeFile(path.join(unmerged, 'work.txt'), 'work\n');
    gitIn(unmerged, 'add', '.');
    gitIn(unmerged, 'commit', '-q', '-m', 'work');
    const kept = await remove(call, { path: unmerged, deleteBranch: true });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual(kept.body.data, { removed: true, path: unmerged, branchDeleted: false });
    assert.equal(gitIn(repo, 'branch', '--list', 'foreman/unmerged').trim(), 'foreman/unmerged', 'git branch -d refused unmerged work');
  });
});

test('DELETE refuses a worktree with uncommitted changes (409 WORKTREE_DIRTY) unless force, which also deletes the branch with -D', async () => {
  await withWorktrees(async ({ call, repo, store }) => {
    const worktree = (await create(call, { projectPath: repo, branch: 'foreman/dirty' })).body.data.path;
    await writeFile(path.join(worktree, 'work.txt'), 'committed\n');
    gitIn(worktree, 'add', '.');
    gitIn(worktree, 'commit', '-q', '-m', 'work');
    await writeFile(path.join(worktree, 'a.txt'), 'changed\n');
    await writeFile(path.join(worktree, 'new.txt'), 'untracked\n');

    const refused = await remove(call, { path: worktree, deleteBranch: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'WORKTREE_DIRTY');
    assert.match(refused.body.error.message, /2 uncommitted changes/);
    assert.equal(await exists(path.join(worktree, 'new.txt')), true, 'nothing was touched');
    assert.ok(store.has(`foreman.worktree:${worktree}`));

    for (const flags of [{ force: 'yes' }, { deleteBranch: 1 }]) {
      assert.equal((await remove(call, { path: worktree, ...flags })).status, 400, JSON.stringify(flags));
    }

    const forced = await remove(call, { path: worktree, deleteBranch: true, force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.deepEqual(forced.body.data, { removed: true, path: worktree, branchDeleted: true });
    assert.equal(await exists(worktree), false);
    assert.equal(gitIn(repo, 'branch', '--list', 'foreman/dirty'), '');
    // The main checkout's own work is never touched.
    assert.equal(gitIn(repo, 'status', '--porcelain'), '');
  });
});

test('DELETE only takes worktrees the bridge created: never the main checkout, another worktree, or a path outside the worktrees dir', async () => {
  await withWorktrees(async ({ call, directory, repo, worktreesDir, store }) => {
    const ours = (await create(call, { projectPath: repo, branch: 'foreman/task-7' })).body.data.path;
    const theirs = path.join(directory, 'by-hand');
    gitIn(repo, 'worktree', 'add', '-q', theirs, '-b', 'by-hand');

    for (const target of [repo, theirs, '/etc', path.join(worktreesDir, 'desk-unknown'), `${ours}/../../desk`, `${ours}/..`]) {
      const response = await remove(call, { path: target, force: true });
      assert.equal(response.status, 404, target);
      assert.equal(response.body.error.code, 'NOT_A_FOREMAN_WORKTREE', target);
    }
    assert.equal((await remove(call, { path: 'desk' })).status, 400);
    assert.equal((await remove(call, {})).status, 400);

    // Even a registry entry that points outside the worktrees dir (or at the main checkout) is refused.
    store.set(`foreman.worktree:${theirs}`, JSON.stringify({ repoPath: repo, branch: 'by-hand', createdAt: NOW }));
    store.set(`foreman.worktree:${repo}`, JSON.stringify({ repoPath: repo, branch: 'main', createdAt: NOW }));
    for (const target of [theirs, repo]) {
      const response = await remove(call, { path: target, force: true, deleteBranch: true });
      assert.equal(response.status, 404, target);
    }
    assert.equal(await exists(theirs), true);
    assert.equal(await exists(path.join(repo, 'a.txt')), true);
    assert.equal(gitIn(repo, 'branch', '--list', '--format=%(refname:short)', 'by-hand').trim(), 'by-hand');
    assert.match(listedWorktrees(repo), new RegExp(`worktree ${ours}\\n`));
    assert.deepEqual((await readdir(worktreesDir)).sort(), ['desk-foreman-task-7']);
  });
});

test('the worktree routes need the bridge token, and answer 503 when not wired', async () => {
  await withWorktrees(async ({ call, repo }) => {
    assert.equal((await create(call, { projectPath: repo, branch: 'foreman/x' })).status, 503);
    assert.equal((await remove(call, { path: repo })).body.error.code, 'WORKTREES_UNAVAILABLE');
  }, { wired: false });
  await withWorktrees(async ({ call, repo, worktreesDir }) => {
    for (const [method, body] of [['POST', { projectPath: repo, branch: 'foreman/x' }], ['DELETE', { path: repo }]] as const) {
      const response = await call(method, '/projects/worktree', body, null);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'FOREMAN_BRIDGE_UNAUTHORIZED');
    }
    assert.equal(await exists(worktreesDir), false);
  });
});

// ---------------------------------------------------------------------------------------------
// The registry the runtime hooks read
// ---------------------------------------------------------------------------------------------

test('the registry knows a worktree and the folders inside it, survives a restart, and treats junk as not registered', () => {
  const store = new Map<string, string>();
  const backing = { get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => void store.set(key, value), delete: (key: string) => void store.delete(key) };
  const registry = createForemanWorktreeRegistry(backing);
  registry.set('/mnt/dev/.foreman-worktrees/desk-task-1', { repoPath: '/mnt/dev/desk', branch: 'task-1', createdAt: NOW });

  const restarted = createForemanWorktreeRegistry(backing);
  assert.deepEqual(restarted.get('/mnt/dev/.foreman-worktrees/desk-task-1/'), { repoPath: '/mnt/dev/desk', branch: 'task-1', createdAt: NOW });
  assert.equal(restarted.contains('/mnt/dev/.foreman-worktrees/desk-task-1'), true);
  assert.equal(restarted.contains('/mnt/dev/.foreman-worktrees/desk-task-1/packages/api'), true);
  for (const other of ['/mnt/dev/.foreman-worktrees/desk-task-10', '/mnt/dev/.foreman-worktrees', '/mnt/dev/desk', 'relative/path', '']) {
    assert.equal(restarted.contains(other), false, other);
  }

  store.set('foreman.worktree:/x/broken', '{not json');
  store.set('foreman.worktree:/x/partial', JSON.stringify({ branch: 'b' }));
  assert.equal(restarted.get('/x/broken'), null);
  assert.equal(restarted.contains('/x/partial/sub'), false);
  const failing = createForemanWorktreeRegistry({ get: () => { throw new Error('db locked'); }, set: () => undefined, delete: () => undefined });
  assert.equal(failing.contains('/mnt/dev/.foreman-worktrees/desk-task-1'), false);

  restarted.remove('/mnt/dev/.foreman-worktrees/desk-task-1');
  assert.equal(registry.contains('/mnt/dev/.foreman-worktrees/desk-task-1'), false);
});

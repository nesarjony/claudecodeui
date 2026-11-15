import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { createClosedWorktreeCheck, hideClosedForemanWorktrees } from '@/modules/foreman/foreman-closed-worktrees.js';
import { getArchivedProjectsWithSessions, getProjectsWithSessions } from '@/modules/projects/index.js';

const open = (...paths: string[]) => (worktreePath: string) => paths.includes(worktreePath);

test('a project in a worktrees folder is open while the registry holds it, and closed once it does not', () => {
  const closed = createClosedWorktreeCheck({ isOpen: open('/mnt/dev/foreman-next-worktrees/slot-1-b1'), worktreesDir: '/mnt/dev/foreman-next-worktrees' });
  assert.equal(closed('/mnt/dev/foreman-next-worktrees/slot-1-b1'), false);
  assert.equal(closed('/mnt/dev/foreman-next-worktrees/slot-1-b2'), true);
  // The path is compared as the project rows spell it, with or without a trailing slash.
  assert.equal(closed('/mnt/dev/foreman-next-worktrees/slot-1-b1/'), false);
  assert.equal(closed('/mnt/dev/foreman-next-worktrees/slot-1-b2/'), true);
});

test('without FOREMAN_WORKTREES_DIR the folder next to the repository is the one, and every other project is left alone', () => {
  const closed = createClosedWorktreeCheck({ isOpen: open('/mnt/dev/.foreman-worktrees/repo-b1'), worktreesDir: undefined });
  assert.equal(closed('/mnt/dev/.foreman-worktrees/repo-b1'), false);
  assert.equal(closed('/mnt/dev/.foreman-worktrees/repo-b2'), true);
  // A project of the owner's, the worktrees folder itself, a folder deeper inside it, and a worktree of the Worktrees tab (another folder) are not Foreman batches.
  for (const project of ['/mnt/dev/repo', '/mnt/dev/.foreman-worktrees', '/mnt/dev/.foreman-worktrees/repo-b2/sub', '/mnt/dev/repo-worktrees/feature', '/mnt/dev/foreman-next-worktrees/slot-1-b2']) {
    assert.equal(closed(project), false, project);
  }
});

test('a relative FOREMAN_WORKTREES_DIR names no folder, and a symlinked one is compared as the worktree service resolves it', async () => {
  assert.equal(createClosedWorktreeCheck({ isOpen: open(), worktreesDir: 'relative/worktrees' })('relative/worktrees/slot-1-b1'), false);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-closed-'));
  try {
    await mkdir(path.join(directory, 'real'));
    await symlink(path.join(directory, 'real'), path.join(directory, 'link'));
    const real = await realpath(path.join(directory, 'real'));
    const closed = createClosedWorktreeCheck({ isOpen: open(), worktreesDir: path.join(directory, 'link') });
    assert.equal(closed(path.join(real, 'slot-1-b1')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const REPO = '/mnt/dev/frontend/foreman-scratch';
const OPEN = '/mnt/dev/frontend/.foreman-worktrees/foreman-scratch-b2';
const CLOSED = '/mnt/dev/frontend/.foreman-worktrees/foreman-scratch-b1';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'closed-worktrees-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const listed = async () => (await getProjectsWithSessions({ skipSynchronization: true })).map((project) => project.path).sort();
const archived = async () => (await getArchivedProjectsWithSessions({ skipSynchronization: true })).map((project) => project.path).sort();
const session = (id: string, project: string, updatedAt = '2026-11-15T10:00:00.000Z') => sessionsDb.createSession(id, 'claude', project, id, '2026-11-15T10:00:00.000Z', updatedAt);

test('the sidebar lists the worktree of an open batch, and the worktree of a closed one only with the archived projects, with its sessions', async () => {
  hideClosedForemanWorktrees();
  await withIsolatedDatabase(async () => {
    for (const [id, project] of [['s-repo', REPO], ['s-open', OPEN], ['s-closed', CLOSED]] as const) session(id, project);
    // The registry holds a worktree from its making until its batch closes (`foreman-worktrees.service.ts`).
    appConfigDb.set(`foreman.worktree:${OPEN}`, JSON.stringify({ repoPath: REPO, branch: 'foreman/b2', createdAt: '2026-11-15T10:00:00.000Z' }));
    assert.deepEqual(await listed(), [OPEN, REPO]);
    assert.deepEqual(await archived(), [CLOSED]);
    assert.deepEqual((await getArchivedProjectsWithSessions({ skipSynchronization: true }))[0]?.sessions.map((each) => each.id), ['s-closed']);

    // The batch closes: its registry entry goes with its worktree, and its project leaves the sidebar.
    appConfigDb.delete(`foreman.worktree:${OPEN}`);
    assert.deepEqual(await listed(), [REPO]);
    assert.deepEqual(await archived(), [CLOSED, OPEN]);
  });
});

test('a closed batch stays out of the sidebar when a transcript written after it closed has made the session sync reactivate its archived project', async () => {
  hideClosedForemanWorktrees();
  await withIsolatedDatabase(async () => {
    session('s-closed', CLOSED);
    projectsDb.updateProjectIsArchived(CLOSED, true);
    assert.deepEqual(await listed(), []);

    // The worker's last line lands after the worktree is removed: the upsert un-archives the project row, as it does for any archived project.
    session('s-closed', CLOSED, '2026-11-15T10:05:00.000Z');
    assert.equal(projectsDb.getProjectPath(CLOSED)?.isArchived, 0, 'the row is active again');
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await archived(), [CLOSED]);
  });
});

test('a project of the owner\'s keeps its place whether or not it is archived, and an archived one is still only in the archive', async () => {
  hideClosedForemanWorktrees();
  await withIsolatedDatabase(async () => {
    session('s-repo', REPO);
    session('s-other', '/mnt/dev/frontend/other');
    projectsDb.updateProjectIsArchived('/mnt/dev/frontend/other', true);
    assert.deepEqual(await listed(), [REPO]);
    assert.deepEqual(await archived(), ['/mnt/dev/frontend/other']);
  });
});

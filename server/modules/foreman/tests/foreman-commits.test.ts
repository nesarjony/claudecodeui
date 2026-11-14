import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanCommits } from '@/modules/foreman/foreman-commits.service.js';
import { defaultRunGit, type GitRunner } from '@/modules/foreman/foreman-git.service.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8' }).trim();

/** Makes an (empty) commit dated `date` and returns its sha. */
function commit(cwd: string, message: string, date = '2026-11-14T10:00:00Z'): string {
  git(cwd, ['commit', '--allow-empty', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** A temp directory with `init` run in it when asked, and a service whose git calls are counted. */
async function withProject(
  options: { repository: boolean },
  run: (context: { project: string; commits: ReturnType<typeof createForemanCommits>; calls: string[][] }) => Promise<void>,
): Promise<void> {
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-commits-')));
  const calls: string[][] = [];
  const runGit: GitRunner = (args, runOptions) => {
    calls.push(args);
    return defaultRunGit(args, runOptions);
  };
  try {
    if (options.repository) {
      git(project, ['init', '-q']);
    }
    await run({ project, commits: createForemanCommits({ runGit }), calls });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test('a turn that committed is answered by one git call: the head, which is HEAD even when its commit date is older than its parent\'s, and the count', async () => {
  await withProject({ repository: true }, async ({ project, commits, calls }) => {
    const base = commit(project, 'base');
    commit(project, 'one', '2020-01-01T00:00:00Z');
    const head = commit(project, 'two', '2019-01-01T00:00:00Z');
    assert.deepEqual(await commits.standing(project, base), { head, commitsSinceBase: 2 });
    assert.equal(calls.length, 1);
  });
});

test('a turn that committed nothing has the head too, from a second call, and no commits', async () => {
  await withProject({ repository: true }, async ({ project, commits, calls }) => {
    const base = commit(project, 'base');
    assert.deepEqual(await commits.standing(project, base), { head: base, commitsSinceBase: 0 });
    assert.equal(calls.length, 2);
  });
});

test('a project that was moved back behind its base reports the head it is at and no commits', async () => {
  await withProject({ repository: true }, async ({ project, commits }) => {
    const first = commit(project, 'first');
    const base = commit(project, 'second');
    git(project, ['reset', '-q', '--hard', first]);
    assert.deepEqual(await commits.standing(project, base), { head: first, commitsSinceBase: 0 });
  });
});

test('what git cannot say is null: no base, a base the repository does not have, no commit at all, no repository', async () => {
  await withProject({ repository: true }, async ({ project, commits }) => {
    assert.deepEqual(await commits.standing(project, 'a'.repeat(40)), { head: null, commitsSinceBase: null }, 'an empty repository has no HEAD');
    const head = commit(project, 'base');
    assert.deepEqual(await commits.standing(project, null), { head, commitsSinceBase: null });
    assert.deepEqual(await commits.standing(project, 'a'.repeat(40)), { head, commitsSinceBase: null });
    assert.equal(await commits.headOf(project), head);
  });
  await withProject({ repository: false }, async ({ project, commits }) => {
    assert.deepEqual(await commits.standing(project, 'a'.repeat(40)), { head: null, commitsSinceBase: null });
    assert.equal(await commits.headOf(project), null);
  });
});

test('the git directory a project shares is absolute: the checkout\'s own .git, the main repository\'s for a linked worktree, none without a repository', async () => {
  await withProject({ repository: true }, async ({ project, commits }) => {
    commit(project, 'base');
    assert.equal(await commits.gitCommonDirOf(project), path.join(project, '.git'));
    const nested = path.join(project, 'packages');
    git(project, ['worktree', 'add', '-q', '-b', 'task-1', path.join(project, 'linked')]);
    await mkdir(nested);
    assert.equal(await commits.gitCommonDirOf(nested), path.join(project, '.git'), 'from a directory inside the checkout');
    assert.equal(await commits.gitCommonDirOf(path.join(project, 'linked')), path.join(project, '.git'), 'a linked worktree shares the main repository\'s');
  });
  await withProject({ repository: false }, async ({ project, commits }) => {
    assert.equal(await commits.gitCommonDirOf(project), null);
  });
});

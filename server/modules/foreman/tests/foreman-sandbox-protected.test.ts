import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanCommits } from '@/modules/foreman/foreman-commits.service.js';
import { protectedWritePaths } from '@/modules/foreman/foreman-sandbox-protected.service.js';
import { buildSandboxAdditions } from '@/modules/foreman/foreman-sandbox.service.js';
import type { ForemanSandboxScope } from '@/shared/types.js';

import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * Git's and the CLI's own files are read-only in every sandbox, whatever the policy says, and nothing else of a git directory is: checked
 * against real repositories (a repository with linked worktrees, a clone of it, one of its worktrees) whose scope git itself reports.
 */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
const AGENT_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];

type Layout = { main: string; clone: string; worktreeA: string; worktreeB: string; plain: string; scopeOf: (projectPath: string) => Promise<ForemanSandboxScope> };

/** A repository with a commit and two linked worktrees (`a`, `b`), a clone of it and a directory that is no repository, in a fresh temp directory. */
async function withRepositories(run: (layout: Layout) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-protected-')));
  const layout = {
    main: path.join(root, 'main'),
    clone: path.join(root, 'clone'),
    worktreeA: path.join(root, 'wt-a'),
    worktreeB: path.join(root, 'wt-b'),
    plain: path.join(root, 'plain'),
  };
  try {
    await mkdir(layout.main);
    await mkdir(layout.plain);
    git(layout.main, ['init', '-q']);
    git(layout.main, ['commit', '--allow-empty', '-q', '-m', 'base']);
    git(layout.main, ['worktree', 'add', '-q', '-b', 'batch-a', layout.worktreeA]);
    git(layout.main, ['worktree', 'add', '-q', '-b', 'batch-b', layout.worktreeB]);
    git(root, ['clone', '-q', layout.main, layout.clone]);
    const commits = createForemanCommits();
    // The scope as a session start records it: the project and the git directory git reports for it.
    const scopeOf = async (projectPath: string) => ({ projectPath, gitCommonDir: await commits.gitCommonDirOf(projectPath) });
    await run({ ...layout, scopeOf });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const file = (target: string) => ({ path: target, directory: false });
const directory = (target: string) => ({ path: target, directory: true });
const settingsOf = (project: string) => AGENT_SETTINGS.map((name) => file(path.join(project, name)));

/** Whether a run with these additions may not write `target`: a `denyWrite` entry, and an Edit and a Write rule, cover it. */
function denied(additions: ReturnType<typeof buildSandboxAdditions>, target: string): { bash: boolean; fileTools: boolean } {
  const covers = (entry: string) => target === entry || target.startsWith(`${entry}/`);
  const filesystem = (additions.sandbox as { filesystem: { denyWrite: string[] } }).filesystem;
  const ruleCovers = (tool: string) => additions.permissions.deny.some((rule) => {
    const match = new RegExp(`^${tool}\\(/(/.*?)(/\\*\\*)?\\)$`).exec(rule);
    return Boolean(match && (match[2] ? covers(match[1]) : target === match[1]));
  });
  return { bash: filesystem.denyWrite.some(covers), fileTools: ruleCovers('Edit') && ruleCovers('Write') };
}

function assertWritable(additions: ReturnType<typeof buildSandboxAdditions>, targets: string[]): void {
  for (const target of targets) {
    assert.deepEqual(denied(additions, target), { bash: false, fileTools: false }, `${target} stays writable`);
  }
}

const build = (scope: ForemanSandboxScope) => buildSandboxAdditions(samplePolicy(), scope, () => undefined);

test('a clone: its hooks and config and the agent\'s settings are forced read-only; its index, objects, refs and logs are not', async () => {
  await withRepositories(async ({ clone, scopeOf }) => {
    const scope = await scopeOf(clone);
    assert.equal(scope.gitCommonDir, path.join(clone, '.git'));
    const gitDir = path.join(clone, '.git');
    assert.deepEqual(protectedWritePaths(scope), [
      directory(path.join(gitDir, 'hooks')), file(path.join(gitDir, 'config')), file(path.join(gitDir, 'config.worktree')), ...settingsOf(clone),
    ]);
    const additions = build(scope);
    for (const target of [path.join(gitDir, 'hooks/pre-commit'), path.join(gitDir, 'config'), path.join(clone, '.mcp.json'), path.join(clone, '.claude/settings.local.json')]) {
      assert.deepEqual(denied(additions, target), { bash: true, fileTools: true }, target);
    }
    assertWritable(additions, ['index', 'index.lock', 'objects/ab/cdef', 'refs/heads/main', 'logs/HEAD', 'HEAD'].map((name) => path.join(gitDir, name)));
    assertWritable(additions, [gitDir, path.join(clone, 'src/app.ts'), path.join(clone, '.claude')]);
  });
});

test('a linked worktree: its .git file, the shared hooks and config, its own admin files and every other worktree\'s admin directory are forced read-only', async () => {
  await withRepositories(async ({ main, worktreeA, scopeOf }) => {
    const scope = await scopeOf(worktreeA);
    const common = path.join(main, '.git');
    assert.equal(scope.gitCommonDir, common);
    const ownAdmin = path.join(common, 'worktrees', 'wt-a');
    assert.deepEqual(protectedWritePaths(scope), [
      file(path.join(worktreeA, '.git')),
      directory(path.join(common, 'hooks')), file(path.join(common, 'config')), file(path.join(common, 'config.worktree')),
      directory(path.join(common, 'worktrees', 'wt-b')),
      file(path.join(ownAdmin, 'commondir')), file(path.join(ownAdmin, 'gitdir')), file(path.join(ownAdmin, 'config.worktree')),
      ...settingsOf(worktreeA),
    ]);
    const additions = build(scope);
    for (const target of [path.join(worktreeA, '.git'), path.join(common, 'worktrees/wt-b/HEAD'), path.join(ownAdmin, 'commondir'), path.join(common, 'hooks/post-checkout')]) {
      assert.deepEqual(denied(additions, target), { bash: true, fileTools: true }, target);
    }
    assertWritable(additions, ['index', 'objects/ab/cdef', 'refs/heads/batch-a', 'logs/refs/heads/batch-a', 'packed-refs'].map((name) => path.join(common, name)));
    assertWritable(additions, [ownAdmin, ...['index', 'index.lock', 'HEAD', 'logs/HEAD', 'ORIG_HEAD'].map((name) => path.join(ownAdmin, name))]);
  });
});

test('the main checkout of a repository with worktrees: every worktree\'s admin directory is read-only, as well as the hooks and config', async () => {
  await withRepositories(async ({ main, scopeOf }) => {
    const common = path.join(main, '.git');
    assert.deepEqual(protectedWritePaths(await scopeOf(main)), [
      directory(path.join(common, 'hooks')), file(path.join(common, 'config')), file(path.join(common, 'config.worktree')),
      directory(path.join(common, 'worktrees', 'wt-a')), directory(path.join(common, 'worktrees', 'wt-b')),
      ...settingsOf(main),
    ]);
  });
});

test('a worktree added since the last run is covered by the next one: the disk is read for every run', async () => {
  await withRepositories(async ({ main, worktreeA, scopeOf }) => {
    const scope = await scopeOf(worktreeA);
    const later = path.join(path.dirname(main), 'wt-c');
    git(main, ['worktree', 'add', '-q', '-b', 'batch-c', later]);
    assert.ok(protectedWritePaths(scope).some((entry) => entry.path === path.join(main, '.git', 'worktrees', 'wt-c') && entry.directory));
  });
});

test('a directory that is no repository has only the agent\'s settings forced', async () => {
  await withRepositories(async ({ plain, scopeOf }) => {
    const scope = await scopeOf(plain);
    assert.equal(scope.gitCommonDir, null);
    assert.deepEqual(protectedWritePaths(scope), settingsOf(plain));
  });
});

test('what the policy already denies is not repeated, and what it denies besides is kept', async () => {
  await withRepositories(async ({ clone, scopeOf }) => {
    const scope = await scopeOf(clone);
    const hooks = path.join(clone, '.git', 'hooks');
    const policy = samplePolicy({
      filesystem: { ...samplePolicy().filesystem, denyWrite: [hooks, '/mnt/dev/elsewhere'] },
      permissions: { allow: ['Bash'], deny: [`Edit(/${hooks}/**)`, 'Read(//mnt/dev/secret)'] },
    });
    const additions = buildSandboxAdditions(policy, scope, () => undefined);
    const denyWrite = (additions.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
    assert.deepEqual(denyWrite, [hooks, '/mnt/dev/elsewhere', ...protectedWritePaths(scope).slice(1).map((entry) => entry.path)]);
    assert.equal(additions.permissions.deny.filter((rule) => rule === `Edit(/${hooks}/**)`).length, 1);
    assert.deepEqual(additions.permissions.deny.slice(0, 2), [`Edit(/${hooks}/**)`, 'Read(//mnt/dev/secret)']);
    assert.ok(['Write', 'NotebookEdit'].every((tool) => additions.permissions.deny.includes(`${tool}(/${hooks}/**)`)));
    assert.deepEqual(additions.permissions.allow, ['Bash'], 'nothing is allowed by what is forced');
    assert.equal(additions.permissions.deny.length, 2 + protectedWritePaths(scope).length * 3 - 1);
  });
});

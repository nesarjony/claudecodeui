import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanGitService, MAX_DIFF_CHARS, type GitRunner } from '@/modules/foreman/foreman-git.service.js';
import { AppError } from '@/shared/utils.js';

type ProjectRow = { project_id: string; project_path: string; custom_project_name: null; isStarred: number; isArchived: number };

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

function projectRow(projectPath: string, isArchived = 0): ProjectRow {
  return { project_id: `p-${projectPath}`, project_path: projectPath, custom_project_name: null, isStarred: 0, isArchived };
}

/** A temp directory holding one known project at `<root>/project`, plus helpers. */
async function withProject(
  run: (context: { root: string; project: string; service: ReturnType<typeof createForemanGitService> }) => Promise<void>,
  options: { runGit?: GitRunner; archived?: boolean } = {},
): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'foreman-git-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const rows = [projectRow(project, options.archived ? 1 : 0)];
  const service = createForemanGitService({
    projectsDb: {
      getProjectPath: (candidate: string) => (rows.find((row) => row.project_path === candidate) ?? null) as never,
      getProjectPaths: () => rows.filter((row) => !row.isArchived) as never,
    },
    runGit: options.runGit,
  });
  try {
    await run({ root, project, service });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function initRepo(project: string, options: { commit?: boolean } = { commit: true }): Promise<void> {
  git(project, 'init', '-q', '-b', 'main');
  if (options.commit) {
    await writeFile(path.join(project, 'a.txt'), 'old line\nkeep\n');
    await writeFile(path.join(project, 'b.txt'), 'b\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');
  }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------------------------

test('a project that is not a git repository answers isRepo false with empty text', async () => {
  await withProject(async ({ project, service }) => {
    const info = await service.inspect(project);
    assert.deepEqual(info, { path: project, isRepo: false, branch: null, status: '', diffStat: '', diff: '', truncated: false });
  });
});

test('status, diff stat and diff cover tracked changes against HEAD, staged ones included', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    await writeFile(path.join(project, 'a.txt'), 'new line\nkeep\n');
    await writeFile(path.join(project, 'staged.txt'), 'staged content\n');
    git(project, 'add', 'staged.txt');

    const info = await service.inspect(project);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, 'main');
    assert.match(info.status, /^## main/);
    assert.match(info.status, / M a\.txt/);
    assert.match(info.status, /A {2}staged\.txt/);
    assert.match(info.diffStat, /a\.txt\s+\| 2 \+-/);
    assert.match(info.diffStat, /staged\.txt\s+\| 1 \+/);
    assert.match(info.diff, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(info.diff, /^-old line$/m);
    assert.match(info.diff, /^\+new line$/m);
    assert.match(info.diff, /^\+staged content$/m);
    assert.equal(info.truncated, false);
  });
});

test('small untracked files are shown as new-file diffs', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    await mkdir(path.join(project, 'src'));
    await writeFile(path.join(project, 'src', 'fresh.ts'), 'export const x = 1\nexport const y = 2\n');

    const info = await service.inspect(project);
    assert.match(info.status, /\?\? src\//);
    assert.ok(info.diff.includes('--- /dev/null\n+++ b/src/fresh.ts\n@@ -0,0 +1,2 @@\n+export const x = 1\n+export const y = 2\n'), info.diff);
  });
});

test('a repository with no commit yet reports its branch, and shows staged and untracked files', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project, { commit: false });
    await writeFile(path.join(project, 'first.txt'), 'hello\n');
    git(project, 'add', 'first.txt');
    await writeFile(path.join(project, 'loose.txt'), 'loose\n');

    const info = await service.inspect(project);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, 'main');
    assert.match(info.diffStat, /first\.txt\s+\| 1 \+/);
    assert.match(info.diff, /^\+hello$/m);
    assert.match(info.diff, /^\+\+\+ b\/loose\.txt$/m);
  });
});

test('secret-looking files, binaries and symlinks never appear in the diff; long files are capped', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    await writeFile(path.join(project, '.env'), 'API_KEY=abc\n');
    await writeFile(path.join(project, '.env.local'), 'API_KEY=def\n');
    await writeFile(path.join(project, 'server.pem'), 'PRIVATE\n');
    await writeFile(path.join(project, 'secrets.json'), '{"k":1}\n');
    await writeFile(path.join(project, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    await symlink('/etc/hostname', path.join(project, 'link-to-hostname'));
    await writeFile(path.join(project, 'long.txt'), `${'x'.repeat(10_000)}\n`);
    await writeFile(path.join(project, 'plain.txt'), 'plain\n');

    const info = await service.inspect(project);
    for (const hidden of ['API_KEY', 'PRIVATE', '"k":1', 'image.bin', 'hostname']) {
      assert.ok(!info.diff.includes(hidden), `${hidden} must not be in the diff`);
    }
    // Their existence is still visible in the status.
    assert.match(info.status, /\.env/);
    assert.match(info.diff, /^\+\+\+ b\/plain\.txt$/m);

    const long = /^\+\+\+ b\/long\.txt\n@@[^\n]*\n(\+[^\n]*\n)(\+\.\.\. \[file truncated\]\n)/m.exec(info.diff);
    assert.ok(long, 'long.txt is shown, capped, with a marker');
    assert.equal(long[1].length, 4000 + 2, 'the first 4000 characters plus the "+" and the newline');
  });
});

test('a secret-looking tracked file that changed is left out of the diff and the diff stat', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    await writeFile(path.join(project, '.env'), 'TOKEN=one\n');
    await mkdir(path.join(project, 'config'));
    await writeFile(path.join(project, 'config', 'id_rsa'), 'KEY-ONE\n');
    git(project, 'add', '-f', '.env', 'config/id_rsa');
    git(project, 'commit', '-q', '-m', 'tracked secrets (a mistake, but it happens)');
    await writeFile(path.join(project, '.env'), 'TOKEN=two\n');
    await writeFile(path.join(project, 'config', 'id_rsa'), 'KEY-TWO\n');
    await writeFile(path.join(project, 'a.txt'), 'changed\n');

    const info = await service.inspect(project);
    assert.ok(!/TOKEN|KEY-/.test(info.diff), info.diff);
    assert.ok(!/\.env|id_rsa/.test(info.diffStat), info.diffStat);
    assert.match(info.diff, /^\+changed$/m);
    assert.match(info.status, / M \.env/);
  });
});

test('at most 20 untracked files are listed', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    for (let index = 0; index < 30; index += 1) {
      await writeFile(path.join(project, `f${String(index).padStart(2, '0')}.txt`), `file ${index}\n`);
    }
    const info = await service.inspect(project);
    assert.equal((info.diff.match(/^\+\+\+ b\/f\d\d\.txt$/gm) ?? []).length, 20);
  });
});

test('the whole diff is cut at 30000 characters, with a marker and truncated: true', async () => {
  await withProject(async ({ project, service }) => {
    await initRepo(project);
    await writeFile(path.join(project, 'a.txt'), Array.from({ length: 5000 }, (_, index) => `line number ${index} of a big change`).join('\n'));

    const info = await service.inspect(project);
    assert.equal(info.truncated, true);
    assert.ok(info.diff.length <= MAX_DIFF_CHARS, `diff is ${info.diff.length} characters`);
    assert.ok(info.diff.length > MAX_DIFF_CHARS - 200);
    assert.match(info.diff, /\.\.\. \[diff truncated at 30000 characters\]\n$/);
    assert.match(info.diff, /^diff --git a\/a\.txt/);
  });
});

test('a path inside the project is accepted; one outside it, an archived project and a symlink out are not', async () => {
  await withProject(async ({ root, project, service }) => {
    await initRepo(project);
    await mkdir(path.join(project, 'packages', 'api'), { recursive: true });
    await writeFile(path.join(project, 'packages', 'api', 'x.ts'), 'export {}\n');
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), path.join(project, 'escape'));

    const inside = await service.inspect(path.join(project, 'packages', 'api'));
    assert.equal(inside.isRepo, true);
    assert.equal(inside.path, path.join(project, 'packages', 'api'));
    // Run from the subdirectory, git sees only what lies below it.
    assert.match(inside.diff, /^\+\+\+ b\/x\.ts$/m);

    assert.equal((await service.inspect(`${project}/`)).path, project);

    for (const outside of [root, path.join(root, 'elsewhere'), `${project}-sibling`, path.join(project, '..', 'elsewhere'), '/']) {
      const error = await rejection(service.inspect(outside));
      assert.equal(error.statusCode, 422, outside);
      assert.equal(error.code, 'UNKNOWN_PROJECT', outside);
    }
    const viaSymlink = await rejection(service.inspect(path.join(project, 'escape')));
    assert.equal(viaSymlink.code, 'UNKNOWN_PROJECT');

    const missing = await rejection(service.inspect(path.join(project, 'nope')));
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.code, 'PATH_NOT_FOUND');
    const file = await rejection(service.inspect(path.join(project, 'a.txt')));
    assert.equal(file.code, 'PATH_NOT_FOUND');
  });

  await withProject(async ({ project, service }) => {
    assert.equal((await rejection(service.inspect(project))).code, 'UNKNOWN_PROJECT');
  }, { archived: true });
});

test('git is run without a shell, with fixed arguments in the project directory', async () => {
  const calls: Array<{ args: string[]; cwd: string; timeoutMs: number }> = [];
  const runGit: GitRunner = async (args, options) => {
    calls.push({ args, ...options });
    const stdout = args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true\n' : args[0] === 'symbolic-ref' ? 'feature\n' : '';
    return { code: args[0] === 'rev-parse' && args[1] === '--verify' ? 1 : 0, stdout, stderr: '', truncated: false };
  };
  await withProject(async ({ project, service }) => {
    const info = await service.inspect(project);
    assert.equal(info.branch, 'feature');
    assert.ok(calls.length >= 6);
    for (const call of calls) {
      assert.equal(call.cwd, project);
      assert.equal(call.timeoutMs, 10_000);
    }
    assert.deepEqual(calls.map((call) => call.args[0]).sort(), ['diff', 'diff', 'hash-object', 'ls-files', 'rev-parse', 'rev-parse', 'status', 'symbolic-ref']);
    // No HEAD: both diffs compare against the empty tree rather than HEAD.
    const diffs = calls.filter((call) => call.args[0] === 'diff');
    assert.ok(diffs.every((call) => !call.args.includes('HEAD')));
  }, { runGit });
});

test('a git failure other than "not a repository" is reported, not hidden as isRepo false', async () => {
  const runGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository at /x', truncated: false });
  await withProject(async ({ project, service }) => {
    const error = await rejection(service.inspect(project));
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'GIT_FAILED');
    assert.match(error.message, /dubious ownership/);
  }, { runGit });
});

test('the real runner sets GIT_OPTIONAL_LOCKS=0 and no pager, and passes the hardening flags', async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'fake-git-'));
  const log = path.join(bin, 'calls.log');
  await writeFile(
    path.join(bin, 'git'),
    `#!/bin/sh
echo "locks=$GIT_OPTIONAL_LOCKS pager=$GIT_PAGER prompt=$GIT_TERMINAL_PROMPT pwd=$(pwd) args=$*" >> "${log}"
case "$*" in
  *--is-inside-work-tree*) echo true ;;
  *--verify*) echo abc123 ;;
  *symbolic-ref*) echo main ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  try {
    await withProject(async ({ project, service }) => {
      const info = await service.inspect(project);
      assert.equal(info.branch, 'main');
      const lines = (await readFile(log, 'utf8')).trim().split('\n');
      assert.ok(lines.length >= 5);
      for (const line of lines) {
        assert.match(line, /^locks=0 pager=cat prompt=0 pwd=/);
        assert.ok(line.includes(`pwd=${project}`), line);
        assert.match(line, /args=--no-pager -c core\.quotepath=false -c core\.fsmonitor=false /);
      }
      const diffs = lines.filter((line) => / diff /.test(line));
      assert.equal(diffs.length, 2);
      assert.ok(diffs.every((line) => line.includes('--no-ext-diff') && line.includes('HEAD')));
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(bin, { recursive: true, force: true });
  }
});

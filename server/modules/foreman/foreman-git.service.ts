import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { projectsDb } from '@/modules/database/index.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

/** What `GET /api/foreman/projects/git` reports about a project's working tree. */
export type ForemanGitInfo = {
  path: string;
  isRepo: boolean;
  branch: string | null;
  /** `git status --porcelain=v1 -b`. */
  status: string;
  /** `git diff --stat HEAD` (against the empty tree while there is no commit yet). */
  diffStat: string;
  /** `git diff HEAD` plus small untracked files shown as new-file diffs; at most 30000 characters. */
  diff: string;
  /** True when `diff` (or `status` / `diffStat`) was cut. */
  truncated: boolean;
};

export type GitRunResult = { code: number; stdout: string; stderr: string; truncated: boolean };

/** Runs `git` with these arguments in `cwd`. Never a shell. Injectable so tests need no real repository. */
export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<GitRunResult>;

export const MAX_DIFF_CHARS = 30_000;
const MAX_TEXT_CHARS = 10_000;
const GIT_TIMEOUT_MS = 10_000;
// A diff can be huge (lockfiles, generated files); the child is cut off once this much has been read.
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_FILE_CHARS = 4000;
const BINARY_SNIFF_BYTES = 8000;
const DIFF_TRUNCATED_MARKER = '\n... [diff truncated at 30000 characters]\n';
const TEXT_TRUNCATED_MARKER = '\n... [truncated]\n';

// Files whose content must not travel to a supervisor model: skipped from the untracked listing and left out of the
// tracked diff. Deliberately broad (`.env.example` is hidden too); `status` still names every changed file.
const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\.[\w.-]+)?$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.(aws|ssh|gnupg|netrc|npmrc|pypirc)(\/|$)/i,
  /(^|\/)(credentials|secrets?)(\.[\w]+)?$/i,
];
const DIFF_EXCLUDE_PATHSPECS = [
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)**/id_ed25519*',
  ':(exclude,glob)**/id_ecdsa*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/*.p12',
  ':(exclude,glob)**/*.pfx',
  ':(exclude,glob)**/.aws/**',
  ':(exclude,glob)**/.ssh/**',
  ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/credentials',
  ':(exclude,glob)**/credentials.*',
  ':(exclude,glob)**/secret',
  ':(exclude,glob)**/secret.*',
  ':(exclude,glob)**/secrets',
  ':(exclude,glob)**/secrets.*',
];

// Hardening on top of `execFile` (no shell): no pager, no prompts, no optional index locks (read-only calls must not
// write to the repo), and no commands from the repo's own config (fsmonitor here; external diff and textconv are
// switched off on the diff calls themselves).
const GIT_BASE_ARGS = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];

const defaultRunGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_BASE_ARGS, ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, truncated: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; stdout?: string; stderr?: string };
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          // Output beyond the cap is dropped; what was read is still the head of the output.
          resolve({ code: 0, stdout: failure.stdout ?? stdout ?? '', stderr: failure.stderr ?? stderr ?? '', truncated: true });
          return;
        }
        if (typeof failure.code === 'number') {
          resolve({ code: failure.code, stdout: stdout ?? '', stderr: stderr ?? '', truncated: false });
          return;
        }
        reject(failure.killed
          ? new AppError('git did not answer in time.', { code: 'GIT_TIMEOUT', statusCode: 504 })
          : new AppError(`git could not be run: ${failure.message}`, { code: 'GIT_UNAVAILABLE', statusCode: 502 }));
      },
    );
  });

function cut(text: string, maxChars: number, marker: string): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, Math.max(0, maxChars - marker.length)) + marker, truncated: true };
}

/** True when `child` is `root` or lies below it (both already normalized, absolute and without trailing separators). */
const isInside = (child: string, root: string) =>
  child === root || child.startsWith(root === '/' ? '/' : `${root}/`);

const isSecretName = (relativePath: string) => SECRET_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));

/**
 * Shows one small untracked text file the way `git diff` would show a new file. Returns null for what must not be
 * shown: secret-looking names, anything that is not a regular file (symlinks included), binaries.
 */
async function newFileDiff(directory: string, relativePath: string): Promise<string | null> {
  if (isSecretName(relativePath)) {
    return null;
  }
  const absolute = path.resolve(directory, relativePath);
  if (absolute !== directory && !absolute.startsWith(directory + path.sep)) {
    return null;
  }
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }

  const handle = await fs.open(absolute, 'r').catch(() => null);
  if (!handle) {
    return null;
  }
  let content: string;
  try {
    // Up to four bytes per kept character, so a UTF-8 file is cut by characters rather than bytes.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_UNTRACKED_FILE_CHARS * 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return null;
    }
    content = bytes.toString('utf8');
  } finally {
    await handle.close();
  }

  const clipped = content.length > MAX_UNTRACKED_FILE_CHARS || stat.size > MAX_UNTRACKED_FILE_CHARS * 4;
  const body = clipped ? content.slice(0, MAX_UNTRACKED_FILE_CHARS) : content;
  const lines = body.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const added = lines.map((line) => `+${line}`);
  if (clipped) {
    added.push('+... [file truncated]');
  }
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added,
    '',
  ].join('\n');
}

/**
 * Read-only git facts about a cloudcli project for Foreman: status, diff stat, and the diff of everything not yet
 * committed (so a reviewer sees new files too). Runs `git` without a shell, with fixed arguments.
 */
// Consumed by foreman.routes.ts for `GET /projects/git`.
export function createForemanGitService(dependencies: {
  projectsDb: Pick<typeof projectsDb, 'getProjectPath' | 'getProjectPaths'>;
  runGit?: GitRunner;
  timeoutMs?: number;
}) {
  const runGit = dependencies.runGit ?? defaultRunGit;
  const timeoutMs = dependencies.timeoutMs ?? GIT_TIMEOUT_MS;

  /** The normalized path when it is a known (active) project or inside one; otherwise a 422. */
  async function resolveProjectDirectory(requestedPath: string): Promise<string> {
    const normalized = normalizeProjectPath(requestedPath);
    const exact = dependencies.projectsDb.getProjectPath(normalized);
    const project = exact && !exact.isArchived
      ? exact
      : dependencies.projectsDb
        .getProjectPaths()
        .find((candidate) => !candidate.isArchived && isInside(normalized, normalizeProjectPath(candidate.project_path)));
    if (!normalized.startsWith('/') || !project) {
      throw new AppError('path is not a known cloudcli project or inside one.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
    }

    // A symlink inside a project must not lead out of it.
    const [realTarget, realProject] = await Promise.all([
      fs.realpath(normalized).catch(() => null),
      fs.realpath(project.project_path).catch(() => null),
    ]);
    if (!realTarget) {
      throw new AppError('path does not exist.', { code: 'PATH_NOT_FOUND', statusCode: 404 });
    }
    if (realProject && !isInside(realTarget, realProject)) {
      throw new AppError('path is not a known cloudcli project or inside one.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
    }
    if (!(await fs.stat(realTarget)).isDirectory()) {
      throw new AppError('path is not a directory.', { code: 'PATH_NOT_FOUND', statusCode: 404 });
    }
    return normalized;
  }

  async function git(args: string[], cwd: string): Promise<GitRunResult> {
    return runGit(args, { cwd, timeoutMs });
  }

  return {
    async inspect(requestedPath: string): Promise<ForemanGitInfo> {
      const directory = await resolveProjectDirectory(requestedPath);
      const empty: ForemanGitInfo = { path: directory, isRepo: false, branch: null, status: '', diffStat: '', diff: '', truncated: false };

      const inside = await git(['rev-parse', '--is-inside-work-tree'], directory);
      if (inside.code !== 0) {
        if (/not a git repository/i.test(inside.stderr)) {
          return empty;
        }
        throw new AppError(`git failed: ${inside.stderr.trim().slice(0, 300) || `exit code ${inside.code}`}`, { code: 'GIT_FAILED', statusCode: 502 });
      }
      if (inside.stdout.trim() !== 'true') {
        return empty;
      }

      // Against HEAD, or against the empty tree while the branch has no commit yet (shows what is staged, too).
      const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], directory);
      let base = 'HEAD';
      if (head.code !== 0) {
        const emptyTree = await git(['hash-object', '-t', 'tree', '/dev/null'], directory);
        base = emptyTree.stdout.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      }

      const [branch, status, diffStat, diff, untracked] = await Promise.all([
        git(['symbolic-ref', '--short', '--quiet', 'HEAD'], directory),
        git(['status', '--porcelain=v1', '-b'], directory),
        git(['diff', '--no-color', '--no-ext-diff', '--stat', base, '--', '.', ...DIFF_EXCLUDE_PATHSPECS], directory),
        git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, '--', '.', ...DIFF_EXCLUDE_PATHSPECS], directory),
        git(['ls-files', '--others', '--exclude-standard', '-z'], directory),
      ]);
      for (const result of [status, diffStat, diff]) {
        if (result.code !== 0) {
          throw new AppError(`git failed: ${result.stderr.trim().slice(0, 300) || `exit code ${result.code}`}`, { code: 'GIT_FAILED', statusCode: 502 });
        }
      }

      const tracked = diff.stdout && !diff.stdout.endsWith('\n') ? `${diff.stdout}\n` : diff.stdout;
      const pieces = [tracked];
      const untrackedNames = untracked.code === 0 ? untracked.stdout.split('\0').filter(Boolean).sort() : [];
      let listed = 0;
      for (const name of untrackedNames) {
        if (listed >= MAX_UNTRACKED_FILES) {
          break;
        }
        const shown = await newFileDiff(directory, name);
        if (shown !== null) {
          pieces.push(shown);
          listed += 1;
        }
      }

      const statusText = cut(status.stdout, MAX_TEXT_CHARS, TEXT_TRUNCATED_MARKER);
      const statText = cut(diffStat.stdout, MAX_TEXT_CHARS, TEXT_TRUNCATED_MARKER);
      const diffText = cut(pieces.join(''), MAX_DIFF_CHARS, DIFF_TRUNCATED_MARKER);

      return {
        path: directory,
        isRepo: true,
        branch: branch.code === 0 ? branch.stdout.trim() || null : null,
        status: statusText.text,
        diffStat: statText.text,
        diff: diffText.text,
        truncated: diffText.truncated || statusText.truncated || statText.truncated || diff.truncated || diffStat.truncated || status.truncated,
      };
    },
  };
}

export type ForemanGitService = ReturnType<typeof createForemanGitService>;

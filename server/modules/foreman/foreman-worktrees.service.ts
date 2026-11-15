import { promises as fs } from 'node:fs';
import path from 'node:path';

import { defaultRunGit, type GitRunner, type GitRunResult } from '@/modules/foreman/foreman-git.service.js';
import type { WorktreeProjectGateway } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

/**
 * Worktrees for Foreman's tasks (Milestone 6): `POST /api/foreman/projects/worktree` makes a git worktree of a known project on
 * a task branch and registers it as a cloudcli project, so `POST /api/foreman/sessions` can start a worker in it; `DELETE`
 * takes it away again. Every worktree the bridge made is recorded in a registry (cloudcli's `app_config`), which is also how
 * the runtime knows to give a session in it Foreman's compaction hooks.
 *
 * Only `git worktree add|list|remove|prune`, `git branch -d|-D`, `git rev-parse` and `git status` are ever run: never push,
 * reset, clean or checkout, and nothing is run in the repository's main checkout that would touch its working tree.
 */

const WORKTREE_KEY_PREFIX = 'foreman.worktree:';
/** The folder next to the repository that holds its Foreman worktrees, unless `FOREMAN_WORKTREES_DIR` names another. */
export const DEFAULT_WORKTREES_FOLDER = '.foreman-worktrees';
// Long enough for `foreman/<task id>-<slug>` names, short enough that `<repo>-<branch>` stays one valid path component.
export const MAX_WORKTREE_BRANCH_LENGTH = 120;
const MAX_REPO_SLUG_LENGTH = 60;
// Adding or removing a worktree writes a whole checkout; reads are quick.
const GIT_WRITE_TIMEOUT_MS = 120_000;
const GIT_READ_TIMEOUT_MS = 15_000;
const MAX_GIT_MESSAGE = 300;

/** What the registry keeps per worktree (`app_config` key `foreman.worktree:<path>`, JSON). */
export type ForemanWorktreeRecord = { repoPath: string; branch: string; createdAt: string };

/** Key-value storage the registry persists through (cloudcli's `app_config` table in production). */
export type WorktreeRegistryBacking = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
};

/**
 * The worktrees the bridge created, by path. Reads go to the backing store every time (rows are tiny and a restart must not
 * lose them); a store that cannot be read means "not registered", so nothing is ever deleted on a bad read.
 */
// Consumed by foreman.module.ts (shared by the worktree service and the runtime hooks) and by the tests.
export function createForemanWorktreeRegistry(backing: WorktreeRegistryBacking) {
  const keyOf = (worktreePath: string) => `${WORKTREE_KEY_PREFIX}${normalizeProjectPath(worktreePath)}`;

  function get(worktreePath: string): ForemanWorktreeRecord | null {
    try {
      const raw = backing.get(keyOf(worktreePath));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (typeof record.repoPath === 'string' && typeof record.branch === 'string') {
          return { repoPath: record.repoPath, branch: record.branch, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' };
        }
      }
    } catch {
      // Unreadable or not JSON: treated as not registered.
    }
    return null;
  }

  return {
    get,
    set(worktreePath: string, record: ForemanWorktreeRecord): void {
      backing.set(keyOf(worktreePath), JSON.stringify(record));
    },
    remove(worktreePath: string): void {
      backing.delete(keyOf(worktreePath));
    },
    /**
     * Is `projectPath` a registered worktree or inside one? Walks up its ancestors, one key lookup each, so no listing of the
     * table is needed. Never throws.
     */
    contains(projectPath: string): boolean {
      let current = normalizeProjectPath(projectPath);
      if (!current.startsWith('/')) {
        return false;
      }
      for (;;) {
        if (get(current)) {
          return true;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          return false;
        }
        current = parent;
      }
    },
  };
}

export type ForemanWorktreeRegistry = ReturnType<typeof createForemanWorktreeRegistry>;

/**
 * Why `name` is not a valid ref name by the rules of `git check-ref-format` (null when it is): no control characters, spaces,
 * `~ ^ : ? * [ \`, no `..` or `@{`, not `@`, no leading, trailing or doubled `/`, no trailing `.`, and no component that starts
 * with `.` or ends with `.lock`. Like `--branch` (and to keep it from reading as an option) it must not start with `-`.
 */
function refNameProblem(name: string): string | null {
  if (!name) {
    return 'is empty';
  }
  if (name.length > MAX_WORKTREE_BRANCH_LENGTH) {
    return `is longer than ${MAX_WORKTREE_BRANCH_LENGTH} characters`;
  }
  if (name.startsWith('-')) {
    return 'starts with "-"';
  }
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return 'contains a space, a control character or one of ~ ^ : ? * [ \\';
  }
  if (name.includes('..') || name.includes('@{') || name === '@') {
    return 'contains ".." or "@{", or is "@"';
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'starts or ends with "/" or contains "//"';
  }
  if (name.endsWith('.')) {
    return 'ends with "."';
  }
  if (name.split('/').some((component) => component.startsWith('.') || component.endsWith('.lock'))) {
    return 'has a component that starts with "." or ends with ".lock"';
  }
  return null;
}

/** The branch name when git would accept it for a new branch (`git check-ref-format --branch`), else a 400. */
// Consumed by the worktree service below and its tests.
export function validateWorktreeBranch(branch: string): string {
  const problem = branch === 'HEAD' ? 'is "HEAD"' : refNameProblem(branch);
  if (problem) {
    throw new AppError(`branch is not a valid git branch name: it ${problem}.`, { code: 'INVALID_BRANCH', statusCode: 400 });
  }
  return branch;
}

/** The base ref when it is a ref name (`main`, `origin/main`, `v1.2`), `HEAD` or a commit id, else a 400. */
function validateBaseRef(base: string): string {
  const problem = /^[0-9a-f]{7,64}$/i.test(base) ? null : refNameProblem(base);
  if (problem) {
    throw new AppError(`base is not a valid git ref: it ${problem}.`, { code: 'INVALID_BASE', statusCode: 400 });
  }
  return base;
}

/** A path component for the worktree folder: letters, digits, `.`, `_` and `-`; every other run becomes one `-`. */
function slug(value: string, maxLength: number): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxLength)
    .replace(/[-.]+$/g, '');
  return cleaned || 'x';
}

type WorktreeEntry = { path: string; branch: string | null };

/** `git worktree list --porcelain`: one block per worktree, the main checkout first. */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let entry: WorktreeEntry | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        entry = { path: normalizeProjectPath(line.slice('worktree '.length)), branch: null };
        entries.push(entry);
      } else if (entry && line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || null;
      }
    }
  }
  return entries;
}

const gitMessage = (result: GitRunResult) => result.stderr.trim().slice(0, MAX_GIT_MESSAGE) || `exit code ${result.code}`;

const pathExists = (candidate: string) => fs.lstat(candidate).then(() => true, () => false);

type WorktreeServiceDependencies = {
  /** The project registry, used the same way the Worktrees module registers a worktree it opens (the UI's add-project path). */
  projects: Pick<WorktreeProjectGateway, 'getProjectByPath' | 'createProject' | 'restoreProject' | 'archiveProject'>;
  registry: ForemanWorktreeRegistry;
  /** Where every worktree goes (absolute; `FOREMAN_WORKTREES_DIR`); unset means `<repo>/../.foreman-worktrees`. */
  worktreesDir?: string;
  runGit?: GitRunner;
  now?: () => Date;
};

export type ForemanWorktreeCreated = {
  path: string;
  branch: string;
  /** The ref a new branch was made from; null when an existing branch was checked out or the worktree already existed. */
  base: string | null;
  /** The cloudcli project the worktree was made from. */
  projectPath: string;
  /** False when the worktree already existed at that path for that branch (the call is idempotent). */
  created: boolean;
  /** The worktree is a cloudcli project now: `POST /api/foreman/sessions` accepts `path` as its `projectPath`. */
  registered: true;
};

export type ForemanWorktreeRemoved = { removed: true; path: string; branchDeleted: boolean };

/**
 * Creates, registers and removes Foreman's task worktrees. Git runs through `execFile` (no shell) with fixed arguments,
 * timeouts and `GIT_TERMINAL_PROMPT=0`; a worktree path is always `<worktreesDir>/<repoName>-<branchSlug>` and is checked to
 * be directly inside `worktreesDir` before anything is created or removed there.
 */
// Consumed by foreman.routes.ts for `POST` and `DELETE /projects/worktree`.
export function createForemanWorktreesService(dependencies: WorktreeServiceDependencies) {
  const runGit = dependencies.runGit ?? defaultRunGit;
  const now = dependencies.now ?? (() => new Date());

  const git = (args: string[], cwd: string, timeoutMs = GIT_READ_TIMEOUT_MS) => runGit(args, { cwd, timeoutMs });

  /** The worktrees of the repository `cwd` belongs to, its main checkout first; a 422 when it is not a git repository. */
  async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
    const listed = await git(['worktree', 'list', '--porcelain'], cwd);
    const entries = listed.code === 0 ? parseWorktreeList(listed.stdout) : [];
    if (entries.length === 0) {
      throw new AppError(`The project is not a git repository: ${gitMessage(listed)}`, { code: 'NOT_A_GIT_REPOSITORY', statusCode: 422 });
    }
    return entries;
  }

  /** `worktreesDir` for a repository, created if missing and resolved through symlinks so it compares with git's paths. */
  async function worktreesDirFor(repoPath: string, create: boolean): Promise<string> {
    const configured = dependencies.worktreesDir?.trim();
    if (configured && !path.isAbsolute(configured)) {
      throw new AppError('FOREMAN_WORKTREES_DIR must be an absolute path.', { code: 'WORKTREES_DIR_INVALID', statusCode: 500 });
    }
    const directory = normalizeProjectPath(configured || path.join(path.dirname(repoPath), DEFAULT_WORKTREES_FOLDER));
    if (create) {
      await fs.mkdir(directory, { recursive: true });
    }
    return normalizeProjectPath(await fs.realpath(directory).catch(() => directory));
  }

  /** Registers the worktree as an active cloudcli project: a new row, or the archived row of an earlier worktree restored. */
  async function registerProject(worktreePath: string, displayName: string): Promise<void> {
    const existing = dependencies.projects.getProjectByPath(worktreePath);
    if (existing) {
      if (existing.isArchived) {
        await dependencies.projects.restoreProject(existing.project_id);
      }
      return;
    }
    const created = await dependencies.projects.createProject({ projectPath: worktreePath, customName: displayName });
    if (created.outcome === 'reactivated_archived') {
      await dependencies.projects.restoreProject(created.project.projectId);
    }
  }

  return {
    /**
     * Makes (or finds) the worktree of `branch` for a known project: `git worktree add -b <branch> <path> <base>` for a new
     * branch, `git worktree add <path> <branch>` for an existing one, and the existing worktree as it is when that path already
     * holds that branch. The worktree is recorded in the registry and registered as a cloudcli project.
     */
    async create(input: { projectPath: string; branch: string; base?: string }): Promise<ForemanWorktreeCreated> {
      const branch = validateWorktreeBranch(input.branch);
      const base = input.base === undefined ? 'HEAD' : validateBaseRef(input.base);
      const project = dependencies.projects.getProjectByPath(normalizeProjectPath(input.projectPath));
      if (!project || project.isArchived || !(await pathExists(project.project_path))) {
        throw new AppError('projectPath is not a known cloudcli project.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
      }

      // Git runs from the project itself, so the default base `HEAD` is the project's HEAD (which may be a linked worktree's).
      const cwd = project.project_path;
      const entries = await listWorktrees(cwd);
      const repoPath = entries[0].path;
      const worktreesDir = await worktreesDirFor(repoPath, true);
      const repoName = slug(path.basename(repoPath), MAX_REPO_SLUG_LENGTH);
      const target = normalizeProjectPath(path.join(worktreesDir, `${repoName}-${slug(branch, MAX_WORKTREE_BRANCH_LENGTH)}`));
      if (path.dirname(target) !== worktreesDir || target === repoPath) {
        throw new AppError('The worktree path would leave the worktrees directory.', { code: 'INVALID_WORKTREE_PATH', statusCode: 400 });
      }
      const record = { repoPath, branch, createdAt: now().toISOString() };
      const result = (created: boolean, usedBase: string | null): ForemanWorktreeCreated =>
        ({ path: target, branch, base: usedBase, projectPath: project.project_path, created, registered: true });

      const existing = entries.find((entry) => entry.path === target);
      if (existing) {
        if (existing.branch !== branch) {
          throw new AppError(`A worktree for another branch (${existing.branch ?? 'detached'}) already exists at ${target}.`, {
            code: 'WORKTREE_PATH_CONFLICT',
            statusCode: 409,
          });
        }
        // Idempotent: the same call again returns the worktree as it is (registered again if that was lost).
        dependencies.registry.set(target, { ...record, createdAt: dependencies.registry.get(target)?.createdAt || record.createdAt });
        await registerProject(target, `${path.basename(repoPath)} · ${branch}`);
        return result(false, null);
      }
      const checkedOut = entries.find((entry) => entry.branch === branch);
      if (checkedOut) {
        throw new AppError(`Branch "${branch}" is already checked out at ${checkedOut.path}.`, {
          code: 'BRANCH_CHECKED_OUT',
          statusCode: 409,
          details: checkedOut.path,
        });
      }
      if (await pathExists(target)) {
        throw new AppError(`${target} already exists and is not a worktree of this repository.`, { code: 'WORKTREE_PATH_EXISTS', statusCode: 409 });
      }

      const branchExists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)).code === 0;
      if (!branchExists && (await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd)).code !== 0) {
        throw new AppError(`base "${base}" does not name a commit in this repository.`, { code: 'UNKNOWN_BASE', statusCode: 422 });
      }
      const added = await git(
        branchExists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, base],
        cwd,
        GIT_WRITE_TIMEOUT_MS,
      );
      if (added.code !== 0) {
        throw new AppError(`git worktree add failed: ${gitMessage(added)}`, { code: 'WORKTREE_CREATE_FAILED', statusCode: 502 });
      }
      // Recorded before the project is registered, so a worktree whose registration fails can still be found and removed.
      dependencies.registry.set(target, record);
      await registerProject(target, `${path.basename(repoPath)} · ${branch}`);
      return result(true, branchExists ? null : base);
    },

    /**
     * Removes a registered Foreman worktree: refuses one with uncommitted changes unless `force`, then
     * `git worktree remove [--force]`, `git worktree prune`, archives its cloudcli project (its sessions stay readable),
     * forgets it, and deletes its branch when asked (`-d`, or `-D` with `force`). Never the main checkout, never a path that is
     * not directly inside the worktrees directory.
     */
    async remove(input: { path: string; deleteBranch: boolean; force: boolean }): Promise<ForemanWorktreeRemoved> {
      const target = normalizeProjectPath(input.path);
      const record = dependencies.registry.get(target);
      const notOurs = () => new AppError('path is not a worktree the Foreman bridge created.', { code: 'NOT_A_FOREMAN_WORKTREE', statusCode: 404 });
      if (!record) {
        throw notOurs();
      }
      const worktreesDir = await worktreesDirFor(record.repoPath, false);
      if (path.dirname(target) !== worktreesDir || target === normalizeProjectPath(record.repoPath)) {
        throw notOurs();
      }

      const entries = await listWorktrees(record.repoPath);
      if (entries[0].path === target) {
        throw notOurs();
      }
      const entry = entries.find((candidate) => candidate.path === target);
      if (entry) {
        if (!input.force) {
          const status = await git(['status', '--porcelain'], target);
          if (status.code !== 0) {
            throw new AppError(`git status failed: ${gitMessage(status)}`, { code: 'GIT_FAILED', statusCode: 502 });
          }
          const changed = status.stdout.split('\n').filter((line) => line.trim()).length;
          if (changed > 0) {
            throw new AppError(`The worktree has ${changed} uncommitted change${changed === 1 ? '' : 's'}; pass force to discard them.`, {
              code: 'WORKTREE_DIRTY',
              statusCode: 409,
            });
          }
        }
        const removed = await git(['worktree', 'remove', ...(input.force ? ['--force'] : []), target], record.repoPath, GIT_WRITE_TIMEOUT_MS);
        if (removed.code !== 0) {
          throw new AppError(`git worktree remove failed: ${gitMessage(removed)}`, { code: 'WORKTREE_REMOVE_FAILED', statusCode: 409 });
        }
      } else if (await pathExists(target)) {
        // git no longer knows the folder as a worktree; it is left alone rather than deleted by hand.
        throw new AppError(`${target} exists but git does not list it as a worktree; nothing was removed.`, {
          code: 'WORKTREE_NOT_LISTED',
          statusCode: 409,
        });
      }
      await git(['worktree', 'prune'], record.repoPath);

      const project = dependencies.projects.getProjectByPath(target);
      if (project && !project.isArchived) {
        await dependencies.projects.archiveProject(project.project_id);
      }
      dependencies.registry.remove(target);

      let branchDeleted = false;
      const branch = entry?.branch ?? record.branch;
      if (input.deleteBranch && branch && !entries.some((candidate) => candidate.path !== target && candidate.branch === branch)) {
        // `-d` refuses a branch that is not merged; only `force` deletes unmerged work.
        branchDeleted = (await git(['branch', input.force ? '-D' : '-d', branch], record.repoPath)).code === 0;
      }
      return { removed: true, path: target, branchDeleted };
    },
  };
}

export type ForemanWorktreesService = ReturnType<typeof createForemanWorktreesService>;

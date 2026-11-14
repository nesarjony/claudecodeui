import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { ForemanSandboxScope } from '@/shared/types.js';

/**
 * What no sandboxed run may write, whatever its policy says: the files through which git or the CLI would run a worker's code outside the
 * sandbox the next time they run in the session's project (the owner's next commit, Foreman's integrate step, the session's next run).
 *
 * Only these exact paths are denied, never a git directory wholesale: the CLI turns every Edit/Write deny rule into a read-only mount in the
 * sandbox, and git must still write its index, objects, refs and logs. The disk is read at the start of every run, so a worktree added since
 * the last run is covered and the session's own worktree is told apart by what its `.git` file says now.
 */

/** A path a sandboxed run may not write: a directory with everything below it, or a single file. */
// Consumed by foreman-sandbox.service.ts, which turns each into a `denyWrite` entry and Edit/Write/NotebookEdit deny rules.
export type ProtectedPath = { path: string; directory: boolean };

// What the CLI loads from the project on its next run, outside the sandbox: its settings (hooks, allowed tools) and the project's MCP servers.
const AGENT_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
// In a linked worktree's own admin directory: where git looks for the shared repository and for the worktree, and the worktree's own config.
// Rewritten, they point git at another repository whose config runs code.
const OWN_ADMIN_FILES = ['commondir', 'gitdir', 'config.worktree'];

/** What `target` itself is (a symlink is not followed); null when it does not exist. */
function kindOf(target: string): 'directory' | 'file' | 'other' | null {
  try {
    const stats = lstatSync(target);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/** `target` with its symlinks resolved, so that two names of one admin directory compare equal; as given when it cannot be resolved. */
function canonical(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** The admin directory a worktree's `.git` file names (`gitdir: <path>`, relative to the worktree unless absolute); null when it names none. */
function ownAdminDirectory(gitFile: string): string | null {
  try {
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(gitFile, 'utf8'));
    return match ? path.resolve(path.dirname(gitFile), match[1]) : null;
  } catch {
    return null;
  }
}

/** The admin directories of a repository's linked worktrees (the entries of `<gitDir>/worktrees`), in name order; none when it has none. */
function worktreeAdminDirectories(gitDir: string): string[] {
  try {
    return readdirSync(path.join(gitDir, 'worktrees')).sort().map((name) => path.join(gitDir, 'worktrees', name));
  } catch {
    return [];
  }
}

/**
 * The paths a sandboxed run of a session working in `scope` may never write:
 * - of every git directory of the project (the shared one, and the checkout's `.git` when it is a directory): `hooks`, `config`,
 *   `config.worktree`, and every linked worktree's admin directory but the session's own (another batch's must not be redirected);
 * - for a linked worktree (its `.git` is a file): that file, and `commondir`, `gitdir` and `config.worktree` of its own admin directory;
 * - the project's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`.
 * Paths that do not exist are listed too: the sandbox runtime keeps them from being created. A `.git` file whose admin directory cannot be read
 * leaves the session without an own admin directory, so all of them are denied and git fails rather than writes another worktree's.
 */
// Consumed by foreman-sandbox.service.ts (`buildSandboxAdditions`, for every run of a sandboxed session) and by its unit tests.
export function protectedWritePaths(scope: ForemanSandboxScope): ProtectedPath[] {
  const dotGit = path.join(scope.projectPath, '.git');
  const dotGitKind = kindOf(dotGit);
  const ownAdmin = dotGitKind === 'file' ? ownAdminDirectory(dotGit) : null;
  const ownAdminCanonical = ownAdmin ? canonical(ownAdmin) : null;
  const gitDirectories = [...new Set([scope.gitCommonDir, dotGitKind === 'directory' ? dotGit : null].flatMap((directory) => (directory ? [path.resolve(directory)] : [])))];

  const paths: ProtectedPath[] = [];
  const add = (target: string, directory: boolean) => {
    if (!paths.some((entry) => entry.path === target)) {
      paths.push({ path: target, directory });
    }
  };
  if (dotGitKind === 'file') {
    add(dotGit, false);
  }
  for (const gitDir of gitDirectories) {
    add(path.join(gitDir, 'hooks'), true);
    add(path.join(gitDir, 'config'), false);
    add(path.join(gitDir, 'config.worktree'), false);
    for (const admin of worktreeAdminDirectories(gitDir)) {
      if (canonical(admin) !== ownAdminCanonical) {
        add(admin, true);
      }
    }
  }
  if (ownAdmin) {
    OWN_ADMIN_FILES.forEach((name) => add(path.join(ownAdmin, name), false));
  }
  for (const name of AGENT_SETTINGS_FILES) {
    add(path.join(scope.projectPath, name), false);
  }
  return paths;
}

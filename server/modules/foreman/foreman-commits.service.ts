import path from 'node:path';

import { defaultRunGit, type GitRunner } from '@/modules/foreman/foreman-git.service.js';

const GIT_TIMEOUT_MS = 10_000;

/**
 * What a session's project has committed: where it is (`headOf`) and, at the end of a turn, where it is and how far it has moved since the
 * session started (`standing`). Read from the repository itself, never from what the worker says.
 */
// Consumed by foreman.module.ts: the sessions service and the hand-over record the starting commit (`headOf`), the sessions service the git
// directory a sandbox may write (`gitCommonDirOf`); the recorder reads a turn's head and commits (`standing`).
export function createForemanCommits(dependencies: { runGit?: GitRunner } = {}) {
  const runGit = dependencies.runGit ?? defaultRunGit;

  async function git(projectPath: string, args: string[]): Promise<string | null> {
    const result = await runGit(args, { cwd: projectPath, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
    return result && result.code === 0 ? result.stdout.trim() : null;
  }

  const headOf = (projectPath: string): Promise<string | null> => git(projectPath, ['rev-parse', '--verify', 'HEAD']);

  return {
    /** The commit the project is at, or null when it has none or is no repository. */
    headOf,

    /**
     * The git directory the project's worktrees share, absolute: the checkout's own `.git`, or for a linked worktree the main repository's.
     * Null when the project is no repository.
     */
    async gitCommonDirOf(projectPath: string): Promise<string | null> {
      const directory = await git(projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      return directory ? path.resolve(projectPath, directory) : null;
    },

    /**
     * Where the project stands when a turn ends: the commit it is at (`head`; null when it has none or is no repository) and how many commits lie
     * between `base` and it (`commitsSinceBase`; null when git cannot say: no base, the base is gone, no repository). One `rev-list` answers both
     * when anything was committed, because it names HEAD first; a turn that committed nothing costs a second call for HEAD, since an empty range
     * says nothing about it.
     */
    async standing(projectPath: string, base: string | null): Promise<{ head: string | null; commitsSinceBase: number | null }> {
      const listed = base ? await git(projectPath, ['rev-list', `${base}..HEAD`]) : null;
      const shas = listed ? listed.split('\n') : [];
      const [newest] = shas;
      if (newest) {
        return { head: newest, commitsSinceBase: shas.length };
      }
      return { head: await headOf(projectPath), commitsSinceBase: listed === '' ? 0 : null };
    },
  };
}

export type ForemanCommits = ReturnType<typeof createForemanCommits>;

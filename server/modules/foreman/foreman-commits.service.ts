import { defaultRunGit, type GitRunner } from '@/modules/foreman/foreman-git.service.js';

const GIT_TIMEOUT_MS = 10_000;

/**
 * What a session's project has committed: where it is (`headOf`) and how far it has moved since the session started
 * (`commitsSince`). Read from the repository itself, never from what the worker says.
 */
// Consumed by foreman.module.ts: the sessions service records the starting commit, the recorder counts a turn's commits from it.
export function createForemanCommits(dependencies: { runGit?: GitRunner } = {}) {
  const runGit = dependencies.runGit ?? defaultRunGit;

  async function git(projectPath: string, args: string[]): Promise<string | null> {
    const result = await runGit(args, { cwd: projectPath, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
    return result && result.code === 0 ? result.stdout.trim() : null;
  }

  return {
    /** The commit the project is at, or null when it has none or is no repository. */
    headOf: (projectPath: string): Promise<string | null> => git(projectPath, ['rev-parse', '--verify', 'HEAD']),

    /** How many commits lie between `base` and the project's HEAD; null when git cannot say (the base is gone, no repository). */
    async commitsSince(projectPath: string, base: string): Promise<number | null> {
      const count = await git(projectPath, ['rev-list', '--count', `${base}..HEAD`]);
      return count === null ? null : Number.parseInt(count, 10);
    },
  };
}

export type ForemanCommits = ReturnType<typeof createForemanCommits>;

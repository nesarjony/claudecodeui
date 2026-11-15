import { realpathSync } from 'node:fs';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { createForemanWorktreeRegistry, DEFAULT_WORKTREES_FOLDER } from '@/modules/foreman/foreman-worktrees.service.js';
import { registerClosedProjectCheck } from '@/modules/projects/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/** Whether a project is a Foreman worktree whose batch has closed. */
export type ClosedWorktreeCheck = (projectPath: string) => boolean;

/** The folder as git and the project rows spell it: through symlinks, like the worktree service resolves it, and as given when it is not there. */
function resolvedFolder(folder: string): string {
  try {
    return normalizeProjectPath(realpathSync(folder));
  } catch {
    return normalizeProjectPath(folder);
  }
}

/**
 * A Foreman worktree is made directly inside a worktrees folder (`FOREMAN_WORKTREES_DIR`, else `.foreman-worktrees` next to the repository) and is in the
 * registry from its making until its batch closes, so a project in such a folder that the registry no longer holds is a batch that is over. `isOpen` says
 * whether the registry holds a path; nothing else decides, which is why a project row that was reactivated by a late transcript write is still closed.
 */
export function createClosedWorktreeCheck(input: { isOpen: (worktreePath: string) => boolean; worktreesDir: string | undefined }): ClosedWorktreeCheck {
  const configured = input.worktreesDir?.trim();
  const folder = configured && path.isAbsolute(configured) ? resolvedFolder(configured) : undefined;
  return (projectPath) => {
    const worktree = normalizeProjectPath(projectPath);
    const parent = path.dirname(worktree);
    const inWorktreesFolder = parent === folder || path.basename(parent) === DEFAULT_WORKTREES_FOLDER;
    return inWorktreesFolder && !input.isOpen(worktree);
  };
}

/** The check over this process's registry (cloudcli's `app_config`, the one the worktree service writes) and `FOREMAN_WORKTREES_DIR`; made when a list is built, so it is never stale. */
export function closedForemanWorktrees(): ClosedWorktreeCheck {
  const registry = createForemanWorktreeRegistry({
    get: (key) => appConfigDb.get(key),
    set: (key, value) => appConfigDb.set(key, value),
    delete: (key) => appConfigDb.delete(key),
  });
  return createClosedWorktreeCheck({ isOpen: (worktreePath) => registry.get(worktreePath) !== null, worktreesDir: process.env.FOREMAN_WORKTREES_DIR });
}

/** Tells the project lists which batch worktrees are over: the sidebar leaves them out and the archive has them. Called once, when the Foreman module starts. */
export const hideClosedForemanWorktrees = (): void => registerClosedProjectCheck(closedForemanWorktrees);

export {
  generateDisplayName,
  getArchivedProjectsWithSessions,
  getProjectsWithSessions,
} from './services/projects-with-sessions-fetch.service.js';
// registerClosedProjectCheck: used by the Foreman module to say which batch worktrees are over, so the sidebar leaves them out and the archive has them.
export { registerClosedProjectCheck } from './services/project-list-filters.js';
export { updateProjectDisplayName } from './services/project-management.service.js';
// createProject: used by the worktrees module to register a worktree directory as a switchable project.
export { createProject } from './services/project-management.service.js';
// deleteOrArchiveProject: used by Projects routes and Worktrees cleanup to hide or permanently remove a project.
export { deleteOrArchiveProject, deleteSessionJsonlFilesForProjectPath } from './services/project-delete.service.js';
// restoreArchivedProject: used by the worktrees module to re-activate an archived project when its worktree is reopened.
export { restoreArchivedProject } from './services/project-delete.service.js';

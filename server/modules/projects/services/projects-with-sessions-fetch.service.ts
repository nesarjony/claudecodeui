import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { closedProjectCheck } from '@/modules/projects/services/project-list-filters.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { closeSync, openSync, readSync } from 'node:fs';

import { userPreferencesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  /** Started by a script or `claude -p`, not opened as a chat. */
  automated?: boolean;
  /** Hidden by the user (shown only while "show hidden" is on). */
  hidden?: boolean;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  provider_session_id?: string | null;
  jsonl_path?: string | null;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    hiddenAutomated?: number;
    hiddenByUser?: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
  visibility?: SessionVisibility;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
  /** The user's sidebar visibility choices; without it every session is listed. */
  visibility?: SessionVisibility;
};

/** Which sessions the sidebar lists, from the user's synced preferences. */
export type SessionVisibility = {
  showAutomated: boolean;
  showHidden: boolean;
  hiddenIds: ReadonlySet<string>;
};

export const SESSION_VISIBILITY_PREFERENCES = {
  showAutomated: 'sidebar.showAutomatedSessions',
  showHidden: 'sidebar.showHiddenSessions',
  hiddenIds: 'sidebar.hiddenSessionIds',
} as const;

/** Reads the sidebar visibility preferences of one user. */
export function readSessionVisibility(userId: number | null | undefined): SessionVisibility | undefined {
  if (!userId) return undefined;
  const preferences = userPreferencesDb.getPreferences(userId);
  const hiddenIds = preferences[SESSION_VISIBILITY_PREFERENCES.hiddenIds];
  return {
    showAutomated: preferences[SESSION_VISIBILITY_PREFERENCES.showAutomated] === true,
    showHidden: preferences[SESSION_VISIBILITY_PREFERENCES.showHidden] === true,
    hiddenIds: new Set(Array.isArray(hiddenIds) ? hiddenIds.filter((id): id is string => typeof id === 'string') : []),
  };
}

// The transcript's opening lines carry the Claude Code entrypoint; this much
// always covers them. A session's entrypoint never changes, so it is cached.
const ENTRYPOINT_SCAN_BYTES = 64 * 1024;
const automatedSessionCache = new Map<string, boolean>();

/**
 * True for a Claude session started headlessly (`claude -p` or an Agent SDK
 * script, entrypoint `sdk-*`) that was not opened as a chat in CloudCLI.
 * Sessions CloudCLI started carry their own app id, unlike sessions found on
 * disk, whose app id is the provider's.
 */
function isAutomatedSession(row: SessionRepositoryRow): boolean {
  if (row.provider !== 'claude') return false;
  if (!row.provider_session_id || row.provider_session_id !== row.session_id) return false;
  const cached = automatedSessionCache.get(row.session_id);
  if (cached !== undefined) return cached;
  if (!row.jsonl_path) return false;
  let entrypoint: string | null = null;
  try {
    const fd = openSync(row.jsonl_path, 'r');
    try {
      const buffer = Buffer.alloc(ENTRYPOINT_SCAN_BYTES);
      const bytesRead = readSync(fd, buffer, 0, ENTRYPOINT_SCAN_BYTES, 0);
      entrypoint = /"entrypoint":"([^"]+)"/.exec(buffer.toString('utf8', 0, bytesRead))?.[1] ?? null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  // A transcript still being written may not name its entrypoint yet; only a
  // definite answer is cached.
  if (entrypoint === null) return false;
  const automated = entrypoint.startsWith('sdk-');
  automatedSessionCache.set(row.session_id, automated);
  return automated;
}

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
  hiddenAutomated: number;
  hiddenByUser: number;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    hiddenAutomated: number;
    hiddenByUser: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
    hiddenAutomated: 0,
    hiddenByUser: 0,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  if (options.visibility) {
    return readVisibleProjectSessionsPage(projectPath, pagination, options.visibility);
  }
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
    hiddenAutomated: 0,
    hiddenByUser: 0,
  };
}

// Visibility is decided per row (automated runs, user-hidden sessions), so the
// project's rows are filtered before paging; counts and pages then agree.
const ALL_ROWS = 1_000_000;

function readVisibleProjectSessionsPage(
  projectPath: string,
  pagination: { limit: number; offset: number },
  visibility: SessionVisibility,
): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathPage(projectPath, ALL_ROWS, 0) as SessionRepositoryRow[];
  let hiddenAutomated = 0;
  let hiddenByUser = 0;
  const visible: SessionSummary[] = [];
  for (const row of rows) {
    const hidden = visibility.hiddenIds.has(row.session_id);
    const automated = isAutomatedSession(row);
    if (hidden && !visibility.showHidden) {
      hiddenByUser += 1;
      continue;
    }
    if (automated && !hidden && !visibility.showAutomated) {
      hiddenAutomated += 1;
      continue;
    }
    visible.push({ ...mapSessionRowToSummary(row), automated, hidden });
  }
  const page = visible.slice(pagination.offset, pagination.offset + pagination.limit);
  return {
    sessions: page,
    total: visible.length,
    hasMore: pagination.offset + page.length < visible.length,
    hiddenAutomated,
    hiddenByUser,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads the open projects from DB and returns normalized session summaries. A project that a module has registered as over (a batch worktree's
 * worktree once its batch has closed, see `project-list-filters.ts`) is not listed: it is with the archived ones, where its sessions stay readable.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const isClosed = closedProjectCheck();
  const projectRows = (
    projectsDb.getProjectPaths() as Array<{
      project_id: string;
      project_path: string;
      custom_project_name?: string | null;
      isStarred?: number;
    }>
  ).filter((row) => !isClosed(row.project_path));
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
      visibility: options.visibility,
    });

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        hiddenAutomated: sessionsPage.hiddenAutomated,
        hiddenByUser: sessionsPage.hiddenByUser,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 * A project registered as over is archived whatever its row says (see `getProjectsWithSessions`).
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const isClosed = closedProjectCheck();
  const projectRows = [...projectsDb.getArchivedProjectPaths(), ...projectsDb.getProjectPaths().filter((row) => isClosed(row.project_path))] as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        hiddenAutomated: sessionsPage.hiddenAutomated,
        hiddenByUser: sessionsPage.hiddenByUser,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
      hiddenAutomated: sessionsPage.hiddenAutomated,
      hiddenByUser: sessionsPage.hiddenByUser,
    },
  };
}

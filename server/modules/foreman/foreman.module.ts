import {
  appConfigDb,
  foremanEventsDb,
  foremanIdempotencyDb,
  foremanSessionStateDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { createBridgeAuthMiddleware, resolveBridgeTokenFile, resolveEventsTokenFile } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanCommits } from '@/modules/foreman/foreman-commits.service.js';
import { createForemanEventPusher } from '@/modules/foreman/foreman-event-push.service.js';
import { createForemanEventRecorder } from '@/modules/foreman/foreman-event-recorder.service.js';
import { createForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import { createForemanGitService } from '@/modules/foreman/foreman-git.service.js';
import { createForemanHandoverService } from '@/modules/foreman/foreman-handover.service.js';
import { createForemanIdempotency } from '@/modules/foreman/foreman-idempotency.service.js';
import { createManagedSessionStore } from '@/modules/foreman/foreman-managed-sessions.service.js';
import { createForemanRuntimeHooks } from '@/modules/foreman/foreman-runtime-hooks.service.js';
import { buildSandboxAdditions } from '@/modules/foreman/foreman-sandbox.service.js';
import {
  createForemanSessionReadsService,
  type ForemanSessionReadsDependencies,
  type LiveContextUsage,
} from '@/modules/foreman/foreman-session-reads.service.js';
import { createForemanSessionStateService, type ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import { createForemanSessionsService, type ForemanSessionsDependencies } from '@/modules/foreman/foreman-sessions.service.js';
import {
  createForemanSuggestionsClient,
  createSuggestionBroadcaster,
} from '@/modules/foreman/foreman-suggestions.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import { createForemanUiRouter } from '@/modules/foreman/foreman-ui.routes.js';
import { createForemanWorktreeRegistry, createForemanWorktreesService } from '@/modules/foreman/foreman-worktrees.service.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';
import { createProject, deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/index.js';
import {
  getActiveClaudeSDKSessions,
  getClaudeSessionContextUsage,
  getLiveBackgroundTasks,
  hasClaudeApiKey,
  isClaudeSDKSessionActive,
  providerModelsService,
  providerRuntimeService,
  sessionsService,
  setClaudeRuntimeAdditionsProvider,
  setClaudeRuntimeSandboxProvider,
  setClaudeSessionModel,
  subscribeClaudeRuntimeEvents,
} from '@/modules/providers/index.js';
import {
  broadcastSessionUpserted,
  chatRunRegistry,
  connectedClients,
  runDetachedChatTurn,
  WS_OPEN_STATE,
} from '@/modules/websocket/index.js';

/** Narrows the SDK's context-usage report (typed loosely in the JS runtime) to what the bridge reads. */
function readLiveContextUsage(raw: unknown): LiveContextUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const usage = raw as Partial<LiveContextUsage>;
  if (typeof usage.totalTokens !== 'number' || typeof usage.maxTokens !== 'number') {
    return null;
  }
  return {
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    rawMaxTokens: typeof usage.rawMaxTokens === 'number' ? usage.rawMaxTokens : usage.maxTokens,
    model: typeof usage.model === 'string' ? usage.model : '',
    isAutoCompactEnabled: usage.isAutoCompactEnabled === true,
    autoCompactThreshold: typeof usage.autoCompactThreshold === 'number' ? usage.autoCompactThreshold : undefined,
    categories: Array.isArray(usage.categories) ? usage.categories : [],
  };
}

/**
 * Assembles the Foreman bridge: the token-protected `/api/foreman` router, the event log of the sessions it drives with the push that
 * reports those events to the Foreman service, and the sandbox every one of those sessions runs in.
 *
 * Subscribing here (rather than from the runtime) keeps the dependency one-way: the Claude runtime publishes generic lifecycle events
 * and knows nothing about Foreman.
 */
// Consumed by the server entrypoint: it mounts `router` at /api/foreman and calls `resumeEventPush` once the database is ready.
export function createForemanModule() {
  const tokenFile = resolveBridgeTokenFile();
  const debugEnabled = Boolean(process.env.FOREMAN_BRIDGE_DEBUG);
  // Task links live in cloudcli's app_config table, so they survive restarts without a schema change.
  const taskIds = createTaskIdStore({
    get: (key) => appConfigDb.get(key),
    set: (key, value) => appConfigDb.set(key, value),
  });
  // Sessions started through the bridge are marked the same way, so they keep the worker autocompact threshold on resume.
  const managed = createManagedSessionStore({
    get: (key) => appConfigDb.get(key),
    set: (key, value) => appConfigDb.set(key, value),
  });
  // The worktrees the bridge created for tasks, also kept in app_config so they survive restarts.
  const worktreeRegistry = createForemanWorktreeRegistry({
    get: (key) => appConfigDb.get(key),
    set: (key, value) => appConfigDb.set(key, value),
    delete: (key) => appConfigDb.delete(key),
  });
  // Foreman's PreCompact/SessionStart hooks (Foreman repos and their task worktrees only), the autocompact threshold and the
  // subagents (bridge sessions only) are added to each Claude run through this provider; it never throws and a Foreman that is
  // down just means no additions.
  const runtimeHooks = createForemanRuntimeHooks({
    tokenFile,
    isManagedSession: (sessionId) => managed.has(sessionId),
    isForemanWorktree: (projectPath) => worktreeRegistry.contains(projectPath),
    warn: (message) => console.warn(`[Foreman bridge] ${message}`),
    debug: (message) => {
      if (debugEnabled) {
        console.debug(`[Foreman bridge] ${message}`);
      }
    },
  });
  setClaudeRuntimeAdditionsProvider((session) => runtimeHooks.forSession(session));

  // Status, permission mode and sandbox of the sessions the bridge starts or drives, kept in cloudcli's database so they
  // survive a restart. The module is built before the database is initialised: the state service settles the previous
  // process's leftovers (running -> idle, with a log line) the first time anything reads or writes it.
  const sessionState = createForemanSessionStateService({
    store: foremanSessionStateDb,
    log: (message) => console.log(`[Foreman bridge] ${message}`),
  });
  // A session that has a sandbox runs in it or not at all: the runtime asks for it before every run and refuses on `refuse`. The run says
  // whether it is one the bridge dispatched for a sandboxed session, which is refused when its sandbox cannot be found.
  setClaudeRuntimeSandboxProvider((sessionId, run) => {
    const sandbox = sessionState.sandboxOf(sessionId, run);
    return sandbox && ('refuse' in sandbox ? sandbox : buildSandboxAdditions(sandbox.policy));
  });

  const events = createForemanEventStore({ storage: foremanEventsDb });
  const commits = createForemanCommits();
  const log = (message: string) => console.warn(`[Foreman bridge] ${message}`);
  const pusher = createForemanEventPusher({
    store: events,
    eventsUrl: process.env.FOREMAN_EVENTS_URL?.trim() || undefined,
    tokenFile: resolveEventsTokenFile(tokenFile),
    log: (message) => {
      if (debugEnabled) {
        console.debug(`[Foreman bridge] ${message}`);
      }
    },
  });
  const recorder = createForemanEventRecorder({
    store: events,
    commits,
    startOf: (sessionId) => {
      const state = sessionState.get(sessionId);
      return state && state.supervision !== 'released' ? { baseHead: state.baseHead, baseSequence: state.baseSequence } : null;
    },
    onStored: () => void pusher.kick(),
    log,
  });

  // Runs synchronously inside the runtime loop: every call only records/queues and never throws.
  subscribeClaudeRuntimeEvents((event) => {
    sessionState.observe(event);
    recorder.handle(event);
  });

  // The cloudcli pieces the session services share: the chat run registry and the Claude runtime, seen through the narrow shapes each service asks for.
  const runs: ForemanSessionReadsDependencies['runs'] & ForemanSessionsDependencies['runs'] = {
    isProcessing: (sessionId) => chatRunRegistry.isProcessing(sessionId),
    listRunningSessionIds: () => chatRunRegistry.listRunningRuns().map((run) => run.sessionId),
    completeRun: (sessionId, options) => chatRunRegistry.completeRun(sessionId, options),
  };
  const runtime: ForemanSessionReadsDependencies['runtime'] & ForemanSessionsDependencies['runtime'] = {
    abort: (sessionId) => providerRuntimeService.abort('claude', sessionId),
    isLive: (sessionId) => Boolean(isClaudeSDKSessionActive(sessionId)),
    liveSessionIds: () => getActiveClaudeSDKSessions(),
    pendingApprovals: (sessionId) => providerRuntimeService.getPendingApprovalsForSession(sessionId),
    // The same resolver the chat UI's `chat.permission-response` reaches: first answer wins.
    resolvePermission: (requestId, decision) => providerRuntimeService.resolveToolApproval(requestId, decision),
    backgroundTasks: (sessionId) => getLiveBackgroundTasks(sessionId),
    setModel: (sessionId, model) => setClaudeSessionModel(sessionId, model),
    contextUsage: async (sessionId) => readLiveContextUsage(await getClaudeSessionContextUsage(sessionId)),
    hasApiKey: () => hasClaudeApiKey(),
  };
  const headOf = (projectPath: string) => commits.headOf(projectPath);

  // What a session is: listing, status, events, digest and context. The other two services look sessions up through it.
  const reads = createForemanSessionReadsService({ sessionsDb, runs, runtime, state: sessionState, events, taskIds });
  const sessions = createForemanSessionsService({
    reads,
    sessionsDb,
    projectsDb,
    createAppSession: (projectPath, initialMessage) =>
      sessionsService.createAppSession('claude', projectPath, initialMessage),
    startTurn: (input) =>
      runDetachedChatTurn(
        {
          sessionId: input.sessionId,
          // The single cloudcli user, so push/desktop notifications behave as for a UI-started run.
          userId: userDb.getFirstUser()?.id ?? null,
          content: input.content,
          options: input.options,
          interruptActiveRun: input.interruptActiveRun,
        },
        { runtime: providerRuntimeService },
      ),
    runs,
    runtime,
    setSessionModel: (sessionId, model) => {
      providerModelsService.setSessionModel('claude', sessionId, model);
    },
    state: sessionState,
    headOf,
    taskIds,
    managed,
    announceSession: (sessionId) => broadcastSessionUpserted(sessionId),
  });
  // The owner hands a session to Foreman and takes it back.
  const handover = createForemanHandoverService({
    reads,
    state: sessionState,
    events,
    headOf,
    settleEvents: () => recorder.whenIdle(),
    taskIds,
  });

  const router = createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    sessions,
    reads,
    handover,
    idempotency: createForemanIdempotency({ storage: foremanIdempotencyDb }),
    git: createForemanGitService({ projectsDb }),
    // A worktree is registered as a project the way the Worktrees module registers one it opens (the add-project path).
    worktrees: createForemanWorktreesService({
      projects: {
        getProjectByPath: (projectPath) => projectsDb.getProjectPath(projectPath),
        // The path is one the worktree service computed itself, inside its worktrees directory next to a project cloudcli already
        // knows. The workspace-root rule (paths under the user's home) is meant for a path a person types: applied here it would
        // refuse every worktree of a repository that lives outside the home directory (/mnt/dev/...).
        createProject: (input) =>
          createProject(input, {
            validatePath: async (projectPath) => ({ valid: true, resolvedPath: projectPath }),
            ensureWorkspaceDirectory: async () => undefined,
            persistProjectPath: (projectPath, customName) => projectsDb.createProjectPath(projectPath, customName),
            getProjectByPath: (projectPath) => projectsDb.getProjectPath(projectPath),
          }),
        restoreProject: (projectId) => restoreArchivedProject(projectId),
        archiveProject: (projectId) => deleteOrArchiveProject(projectId, false),
      },
      registry: worktreeRegistry,
      worktreesDir: process.env.FOREMAN_WORKTREES_DIR || undefined,
    }),
    // Foreman's suggestions go to every open chat socket; each chat keeps the ones for its own session.
    suggestions: createSuggestionBroadcaster({ clients: () => connectedClients, openState: WS_OPEN_STATE }),
  });

  return {
    router,
    /** The sessions Foreman supervises, for the logged-in UI. */
    state: sessionState,
    /** Pushes the events a previous process stored and never saw acknowledged. Called once the database is initialised. */
    resumeEventPush: () => void pusher.kick(),
  };
}

/**
 * The user-facing half of the suggestion card: the pending suggestion for a session and the user's feedback,
 * proxied to Foreman with the bridge token (kept server-side), and which sessions Foreman supervises. Mounted at `/api/foreman-suggestions` behind the
 * normal cloudcli login, unlike the bridge router.
 */
// Consumed by the server entrypoint, which mounts the returned router.
export function createForemanUiModule(state: ForemanSessionStateService) {
  return createForemanUiRouter({
    client: createForemanSuggestionsClient({ tokenFile: resolveBridgeTokenFile() }),
    state,
  });
}

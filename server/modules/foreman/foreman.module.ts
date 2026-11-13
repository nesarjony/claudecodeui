import { appConfigDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { createBridgeAuthMiddleware, resolveBridgeTokenFile } from '@/modules/foreman/foreman-auth.service.js';
import {
  createForemanEventPusher,
  createRuntimeOutcomeTracker,
  splitModelBilling,
} from '@/modules/foreman/foreman-events.service.js';
import { createForemanGitService } from '@/modules/foreman/foreman-git.service.js';
import { createForemanSessionsService, type LiveContextUsage } from '@/modules/foreman/foreman-sessions.service.js';
import {
  createForemanSuggestionsClient,
  createSuggestionBroadcaster,
} from '@/modules/foreman/foreman-suggestions.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import { createForemanUiRouter } from '@/modules/foreman/foreman-ui.routes.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';
import {
  getActiveClaudeSDKSessions,
  getClaudeSessionContextUsage,
  getLiveBackgroundTasks,
  hasClaudeApiKey,
  isClaudeSDKSessionActive,
  providerModelsService,
  providerRuntimeService,
  sessionsService,
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
 * Assembles the Foreman bridge: the token-protected `/api/foreman` router plus the event push
 * that reports Claude session events to the Foreman service.
 *
 * Subscribing here (rather than from the runtime) keeps the dependency one-way: the Claude
 * runtime publishes generic lifecycle events and knows nothing about Foreman.
 */
// Consumed by the server entrypoint, which mounts the returned router at /api/foreman.
export function createForemanModule() {
  const tokenFile = resolveBridgeTokenFile();
  const outcomes = createRuntimeOutcomeTracker();
  const debugEnabled = Boolean(process.env.FOREMAN_BRIDGE_DEBUG);
  // Task links live in cloudcli's app_config table, so they survive restarts without a schema change.
  const taskIds = createTaskIdStore({
    get: (key) => appConfigDb.get(key),
    set: (key, value) => appConfigDb.set(key, value),
  });
  const pusher = createForemanEventPusher({
    tokenFile,
    describeSession: (sessionId) => {
      const row = sessionsDb.getSessionById(sessionId);
      return {
        billing: row ? splitModelBilling(row.model).billing : null,
        title: row?.custom_name ?? null,
        taskId: taskIds.get(sessionId) ?? undefined,
      };
    },
    debug: (message) => {
      if (debugEnabled) {
        console.debug(`[Foreman bridge] ${message}`);
      }
    },
  });

  // Runs synchronously inside the runtime loop: both calls only record/queue and never throw.
  subscribeClaudeRuntimeEvents((event) => {
    outcomes.observe(event);
    pusher.handle(event);
  });

  const sessions = createForemanSessionsService({
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
    runs: {
      isProcessing: (sessionId) => chatRunRegistry.isProcessing(sessionId),
      listRunningSessionIds: () => chatRunRegistry.listRunningRuns().map((run) => run.sessionId),
      completeRun: (sessionId, options) => chatRunRegistry.completeRun(sessionId, options),
    },
    runtime: {
      abort: (sessionId) => providerRuntimeService.abort('claude', sessionId),
      isLive: (sessionId) => Boolean(isClaudeSDKSessionActive(sessionId)),
      liveSessionIds: () => getActiveClaudeSDKSessions(),
      pendingApprovals: (sessionId) => providerRuntimeService.getPendingApprovalsForSession(sessionId),
      backgroundTasks: (sessionId) => getLiveBackgroundTasks(sessionId),
      setModel: (sessionId, model) => setClaudeSessionModel(sessionId, model),
      contextUsage: async (sessionId) => readLiveContextUsage(await getClaudeSessionContextUsage(sessionId)),
      hasApiKey: () => hasClaudeApiKey(),
    },
    setSessionModel: (sessionId, model) => {
      providerModelsService.setSessionModel('claude', sessionId, model);
    },
    taskIds,
    announceSession: (sessionId) => broadcastSessionUpserted(sessionId),
    hasFailed: (sessionId) => outcomes.hasFailed(sessionId),
  });

  return createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    sessions,
    git: createForemanGitService({ projectsDb }),
    // Foreman's suggestions go to every open chat socket; each chat keeps the ones for its own session.
    suggestions: createSuggestionBroadcaster({ clients: () => connectedClients, openState: WS_OPEN_STATE }),
  });
}

/**
 * The user-facing half of the suggestion card: the pending suggestion for a session and the user's feedback,
 * proxied to Foreman with the bridge token (kept server-side). Mounted at `/api/foreman-suggestions` behind the
 * normal cloudcli login, unlike the bridge router.
 */
// Consumed by the server entrypoint, which mounts the returned router.
export function createForemanUiModule() {
  return createForemanUiRouter({
    client: createForemanSuggestionsClient({ tokenFile: resolveBridgeTokenFile() }),
  });
}

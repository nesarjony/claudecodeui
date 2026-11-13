import type { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  buildSessionDigest,
  estimateContextFromTranscript,
  hasTurnStarts,
  locateTranscript,
  readTranscriptRows,
  type SessionDigestBody,
} from '@/modules/foreman/foreman-digest.service.js';
import { applyModelBilling, splitModelBilling } from '@/modules/foreman/foreman-events.service.js';
import {
  assertGuardCompatiblePermissionMode,
  compileGuard,
  createToolPolicy,
  type ForemanGuardConfig,
} from '@/modules/foreman/foreman-guard.service.js';
import type { ForemanSessionStatus, ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanBilling } from '@/shared/types.js';
import { AppError, clipText, normalizeProjectPath, summarizeToolInput } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

export type { ForemanSessionStatus } from '@/modules/foreman/foreman-session-state.service.js';

export type ForemanSessionSummary = {
  id: string;
  /** The Foreman task that started the session, when it was started with a `taskId`. */
  taskId: string | null;
  projectPath: string | null;
  title: string | null;
  /** Plain model (the `@api` billing marker is reported as `billing`). */
  model: string | null;
  billing: ForemanBilling;
  status: ForemanSessionStatus;
  /** The permission mode Foreman chose for the session (kept across restarts); null when it never chose one. */
  permissionMode: string | null;
  /** True when the session runs under a risky-action guard (Foreman-started with `guard.enabled`). */
  guarded: boolean;
  /** True when a Claude process or an active run exists for the session right now. */
  live: boolean;
  lastActivity: string | null;
  /** Non-ambient background tasks (shells, monitors, agents) the live process last reported. */
  backgroundTasks: number;
};

/** The part of the SDK's context-usage report the bridge reads. */
export type LiveContextUsage = {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  model: string;
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
  categories: Array<{ name: string; tokens: number; kind: string }>;
};

export type ForemanContextReport = {
  sessionId: string;
  /** `live` = measured by the running process; `transcript` = estimated from the last assistant usage. */
  source: 'live' | 'transcript' | 'unknown';
  model: string | null;
  usedTokens: number | null;
  /** The window the context is measured against (the CLI's compaction window when live). */
  windowTokens: number | null;
  /** The model's hard limit when it differs from the measuring window (live only). */
  rawWindowTokens: number | null;
  fraction: number | null;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean | null;
  /** Largest used categories of a live measurement. */
  categories: Array<{ name: string; tokens: number }>;
  measuredAt: string | null;
  note: string | null;
};

type StartTurnInput = {
  sessionId: string;
  content: string;
  options: Record<string, unknown>;
  interruptActiveRun?: boolean;
};

/**
 * Everything the bridge needs from the rest of cloudcli, injected so the service can be tested
 * without a database, a websocket server, or a Claude process. `foreman.module.ts` wires the
 * production implementations.
 */
export type ForemanBridgeDependencies = {
  sessionsDb: Pick<typeof sessionsDb, 'getSessionById' | 'getRecentSessionsPage' | 'updateSessionCustomName'>;
  projectsDb: Pick<typeof projectsDb, 'getProjectPath'>;
  /** Allocates the stable app session id for a brand-new Claude chat (the UI's `POST /api/providers/sessions`). */
  createAppSession(projectPath: string, initialMessage: string): { sessionId: string; sessionName: string };
  /** Starts a turn exactly like the UI's `chat.send` with no socket attached; settles when the turn's run ends. */
  startTurn(input: StartTurnInput): Promise<{ started: boolean; error: string | null }>;
  runs: {
    isProcessing(sessionId: string): boolean;
    listRunningSessionIds(): string[];
    completeRun(sessionId: string, options: { exitCode: number; aborted: boolean }): void;
  };
  runtime: {
    abort(sessionId: string): Promise<boolean>;
    isLive(sessionId: string): boolean;
    liveSessionIds(): string[];
    pendingApprovals(sessionId: string): unknown[];
    /** Answers a pending permission prompt, exactly like the chat UI's `chat.permission-response`. */
    resolvePermission(requestId: string, decision: { allow: boolean; message?: string }): void;
    backgroundTasks(sessionId: string): Array<{ ambient?: boolean }> | null;
    setModel(sessionId: string, model: string): Promise<boolean>;
    contextUsage(sessionId: string): Promise<LiveContextUsage | null>;
    hasApiKey(): boolean;
  };
  /** Records the model a session runs with (so resumed runs keep it). */
  setSessionModel(sessionId: string, model: string): void;
  /** Status, permission mode and guard of the sessions the bridge starts or drives; survives restarts. */
  state: Pick<ForemanSessionStateService, 'get' | 'track'>;
  /** Remembers/reads which Foreman task a session belongs to. */
  taskIds: { get(sessionId: string): string | null; set(sessionId: string, taskId: string): void };
  /** Tells connected UIs about a session so it appears in the sidebar immediately. */
  announceSession(sessionId: string): Promise<void>;
  hasFailed(sessionId: string): boolean;
  /** Root of Claude's transcripts; defaults to `~/.claude/projects`. */
  claudeProjectsRoot?: string;
  /** How long a started turn is watched for an immediate refusal or failure before the call returns. */
  admissionWindowMs?: number;
  liveContextTimeoutMs?: number;
};

const DEFAULT_ADMISSION_WINDOW_MS = 50;
const DEFAULT_LIVE_CONTEXT_TIMEOUT_MS = 10_000;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 30;
const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 80;
const MAX_PERMISSION_INPUT_LENGTH = 1000;
const TOP_CONTEXT_CATEGORIES = 6;
// Context windows by model family; `[1m]` models have the extended window.
const STANDARD_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** Picks the window a transcript-based estimate is measured against. */
// Consumed by the sessions service below and its tests.
export function resolveContextWindow(model: string | null, usedTokens: number): number {
  if (model?.includes('[1m]') || usedTokens > STANDARD_CONTEXT_WINDOW) {
    return EXTENDED_CONTEXT_WINDOW;
  }
  return STANDARD_CONTEXT_WINDOW;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Orchestrates the bridge's operations over cloudcli's own services: every send, start and
 * stop goes through the same code the UI uses, so a Foreman-driven session behaves (and
 * appears) exactly like one a person started.
 */
// Consumed by foreman.routes.ts, which parses requests and calls these operations.
export function createForemanSessionsService(deps: ForemanBridgeDependencies) {
  const admissionWindowMs = deps.admissionWindowMs ?? DEFAULT_ADMISSION_WINDOW_MS;

  function requireClaudeSession(sessionId: string): SessionRow {
    const session = deps.sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    if (session.provider !== 'claude') {
      throw new AppError('The Foreman bridge only drives Claude sessions.', { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
    }
    return session;
  }

  type PendingApproval = { requestId: string; toolName: string; input: unknown; askedAt: string | null };

  /** The session's unanswered permission prompts, read defensively from the runtime's loosely typed records. */
  function pendingApprovals(sessionId: string): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const entry of deps.runtime.pendingApprovals(sessionId)) {
      const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
      if (!record || typeof record.requestId !== 'string') {
        continue;
      }
      const received = record.receivedAt;
      pending.push({
        requestId: record.requestId,
        toolName: typeof record.toolName === 'string' ? record.toolName : 'UnknownTool',
        input: record.input,
        askedAt: received instanceof Date ? received.toISOString() : typeof received === 'string' ? received : null,
      });
    }
    return pending;
  }

  /**
   * What is true right now wins (a prompt waiting, a run processing); with nothing live, the remembered state decides,
   * so an error that ended a session before a restart is still reported afterwards.
   */
  function statusOf(sessionId: string): ForemanSessionStatus {
    if (pendingApprovals(sessionId).length > 0) {
      return 'waiting_permission';
    }
    if (deps.runs.isProcessing(sessionId)) {
      return 'running';
    }
    return deps.hasFailed(sessionId) || deps.state.get(sessionId)?.status === 'error' ? 'error' : 'idle';
  }

  function summarize(session: SessionRow): ForemanSessionSummary {
    const { model, billing } = splitModelBilling(session.model);
    const tasks = deps.runtime.backgroundTasks(session.session_id) ?? [];
    const state = deps.state.get(session.session_id);
    return {
      id: session.session_id,
      taskId: deps.taskIds.get(session.session_id) ?? state?.taskId ?? null,
      projectPath: session.project_path,
      title: session.custom_name,
      model,
      billing,
      status: statusOf(session.session_id),
      permissionMode: state?.permissionMode ?? null,
      guarded: state?.guard?.enabled === true,
      live: deps.runs.isProcessing(session.session_id) || deps.runtime.isLive(session.session_id),
      lastActivity: session.updated_at ?? session.created_at ?? null,
      backgroundTasks: tasks.filter((task) => !task.ambient).length,
    };
  }

  /** Starts a turn and waits only long enough to report an immediate refusal or startup failure. */
  async function dispatchTurn(input: StartTurnInput): Promise<void> {
    const outcome = deps.startTurn(input).then(
      (result) => ({ ok: true as const, result }),
      (failure: unknown) => ({ ok: false as const, failure }),
    );
    const early = await Promise.race([
      outcome,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), admissionWindowMs);
        timer.unref?.();
      }),
    ]);

    if (!early) {
      // Admitted and still running; whatever happens next reaches Foreman as events.
      void outcome.then((settled) => {
        const message = settled.ok ? settled.result.error : settled.failure instanceof Error ? settled.failure.message : String(settled.failure);
        if (message) {
          console.warn(`[Foreman bridge] turn for session ${input.sessionId} failed: ${message}`);
        }
      });
      return;
    }

    if (!early.ok) {
      throw new AppError(
        `The turn could not be started: ${early.failure instanceof Error ? early.failure.message : String(early.failure)}`,
        { code: 'TURN_START_FAILED', statusCode: 502 },
      );
    }
    if (!early.result.started) {
      const message = early.result.error ?? 'The turn was not started.';
      const lostRace = /already in progress/i.test(message);
      throw new AppError(message, {
        code: lostRace ? 'RUN_IN_PROGRESS' : 'TURN_START_FAILED',
        statusCode: lostRace ? 409 : 502,
      });
    }
    if (early.result.error) {
      throw new AppError(`The turn failed immediately: ${early.result.error}`, { code: 'TURN_START_FAILED', statusCode: 502 });
    }
  }

  async function sendUserTurn(
    sessionId: string,
    text: string,
    options: { interrupt: boolean; permissionMode?: string },
  ): Promise<{ interrupted: boolean }> {
    const session = requireClaudeSession(sessionId);
    const processing = deps.runs.isProcessing(sessionId);
    if (processing && !options.interrupt) {
      throw new AppError(
        'A turn is already running for this session. Wait for turn_end, call interrupt, or send with "interrupt": true.',
        { code: 'RUN_IN_PROGRESS', statusCode: 409 },
      );
    }
    if (!deps.runtime.isLive(sessionId) && splitModelBilling(session.model).billing === 'api-key' && !deps.runtime.hasApiKey()) {
      throw new AppError('This session is billed to the API key, but no API key file is available.', {
        code: 'API_KEY_UNAVAILABLE',
        statusCode: 503,
      });
    }

    // A resumed run (after a restart too) keeps the permission mode Foreman chose and the guard it started with.
    const state = deps.state.get(sessionId);
    const guard = state?.guard?.enabled ? state.guard : null;
    const permissionMode = options.permissionMode ?? state?.permissionMode ?? undefined;
    if (guard) {
      assertGuardCompatiblePermissionMode(permissionMode);
    }
    if (!state || (options.permissionMode && options.permissionMode !== state.permissionMode)) {
      deps.state.track(sessionId, {
        billing: splitModelBilling(session.model).billing,
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      });
    }
    const interrupted = processing && options.interrupt;
    await dispatchTurn({
      sessionId,
      content: text,
      interruptActiveRun: interrupted,
      options: {
        // Same settings the UI sends with every turn: the session's own model and effort.
        model: session.model ?? undefined,
        effort: session.effort ?? undefined,
        permissionMode,
        sessionSummary: clipText(text, MAX_SUMMARY_LENGTH),
        ...(guard ? { toolPolicy: createToolPolicy(compileGuard(guard, session.project_path)) } : {}),
      },
    });
    return { interrupted };
  }

  return {
    /** Live and recent Claude sessions, live ones first. */
    listSessions(options: { limit?: number; projectPath?: string } = {}): ForemanSessionSummary[] {
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT));
      const wantedPath = options.projectPath ? normalizeProjectPath(options.projectPath) : null;

      const rows = new Map<string, SessionRow>();
      for (const row of deps.sessionsDb.getRecentSessionsPage(limit, 0).sessions) {
        if (row.provider === 'claude') {
          rows.set(row.session_id, row);
        }
      }
      // A live session older than the page (e.g. a long-running background run) still belongs in the list.
      for (const sessionId of new Set([...deps.runs.listRunningSessionIds(), ...deps.runtime.liveSessionIds()])) {
        const row = rows.has(sessionId) ? null : deps.sessionsDb.getSessionById(sessionId);
        if (row && row.provider === 'claude' && !row.isArchived) {
          rows.set(row.session_id, row);
        }
      }

      return [...rows.values()]
        .filter((row) => !wantedPath || (row.project_path !== null && normalizeProjectPath(row.project_path) === wantedPath))
        .map(summarize)
        .sort((a, b) => Number(b.live) - Number(a.live) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    },

    /** Condensed view of the last `turns` turns of a session, read from its transcript. */
    async getDigest(sessionId: string, turns: number): Promise<{ session: ForemanSessionSummary; digest: SessionDigestBody }> {
      const session = requireClaudeSession(sessionId);
      const file = await locateTranscript(session, deps.claudeProjectsRoot);
      const transcript = file ? await readTranscriptRows(file, (rows) => hasTurnStarts(rows, turns)) : null;
      if (!transcript) {
        throw new AppError('No transcript exists for this session yet.', { code: 'TRANSCRIPT_NOT_FOUND', statusCode: 404 });
      }
      return {
        session: summarize(session),
        digest: buildSessionDigest(transcript.rows, { turns, truncatedHead: transcript.truncatedHead }),
      };
    },

    /** Context-window usage: measured by the live process when there is one, else estimated from the transcript. */
    async getContext(sessionId: string): Promise<ForemanContextReport> {
      const session = requireClaudeSession(sessionId);
      const { model } = splitModelBilling(session.model);
      let note: string | null = null;

      if (deps.runtime.isLive(sessionId)) {
        try {
          const usage = await withTimeout(
            deps.runtime.contextUsage(sessionId),
            deps.liveContextTimeoutMs ?? DEFAULT_LIVE_CONTEXT_TIMEOUT_MS,
            'context usage',
          );
          if (usage && usage.maxTokens > 0) {
            return {
              sessionId,
              source: 'live',
              model: usage.model || model,
              usedTokens: usage.totalTokens,
              windowTokens: usage.maxTokens,
              rawWindowTokens: usage.rawMaxTokens,
              fraction: usage.totalTokens / usage.maxTokens,
              autoCompactThreshold: usage.autoCompactThreshold ?? null,
              isAutoCompactEnabled: usage.isAutoCompactEnabled,
              categories: usage.categories
                .filter((category) => category.kind === 'used' && category.tokens > 0)
                .sort((a, b) => b.tokens - a.tokens)
                .slice(0, TOP_CONTEXT_CATEGORIES)
                .map(({ name, tokens }) => ({ name, tokens })),
              measuredAt: new Date().toISOString(),
              note: null,
            };
          }
        } catch (error) {
          note = `Live measurement failed (${error instanceof Error ? error.message : String(error)}); estimated from the transcript.`;
        }
      }

      const file = await locateTranscript(session, deps.claudeProjectsRoot);
      const transcript = file ? await readTranscriptRows(file, (rows) => estimateContextFromTranscript(rows) !== null) : null;
      const estimate = transcript ? estimateContextFromTranscript(transcript.rows) : null;
      if (!estimate) {
        return {
          sessionId,
          source: 'unknown',
          model,
          usedTokens: null,
          windowTokens: null,
          rawWindowTokens: null,
          fraction: null,
          autoCompactThreshold: null,
          isAutoCompactEnabled: null,
          categories: [],
          measuredAt: null,
          note: note ?? 'No usage has been recorded for this session yet.',
        };
      }

      const windowTokens = resolveContextWindow(model, estimate.usedTokens);
      return {
        sessionId,
        source: 'transcript',
        model,
        usedTokens: estimate.usedTokens,
        windowTokens,
        rawWindowTokens: null,
        fraction: estimate.usedTokens / windowTokens,
        autoCompactThreshold: null,
        isAutoCompactEnabled: null,
        categories: [],
        measuredAt: estimate.at,
        note: note ?? (estimate.basis === 'compact_boundary'
          ? 'Size right after the last compaction; no request has been made since.'
          : 'Estimated from the last assistant message.'),
      };
    },

    /**
     * Starts a new Claude session in a known project and sends its first prompt, through the same
     * path as the UI. The session id is allocated immediately; the run continues in the background.
     */
    async startSession(input: {
      projectPath: string;
      prompt: string;
      model: string;
      billing: ForemanBilling;
      permissionMode: string;
      effort?: string;
      title?: string;
      taskId?: string;
      guard?: ForemanGuardConfig;
    }) {
      const project = deps.projectsDb.getProjectPath(input.projectPath);
      if (!project || project.isArchived) {
        throw new AppError('projectPath is not a known cloudcli project.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
      }
      const guard = input.guard?.enabled ? input.guard : undefined;
      if (guard) {
        assertGuardCompatiblePermissionMode(input.permissionMode);
      }
      const compiledGuard = guard ? compileGuard(guard, project.project_path) : null;
      if (input.billing === 'api-key' && !deps.runtime.hasApiKey()) {
        throw new AppError('API-key billing was requested, but no API key file is available.', {
          code: 'API_KEY_UNAVAILABLE',
          statusCode: 503,
        });
      }

      const markedModel = applyModelBilling(input.model, input.billing);
      const created = deps.createAppSession(project.project_path, input.title ?? input.prompt);
      if (input.title) {
        deps.sessionsDb.updateSessionCustomName(created.sessionId, clipText(input.title, MAX_TITLE_LENGTH));
      }
      // Recorded before the run starts so even its first event (session_started) carries the task, and a run
      // that is resumed after a restart still has the permission mode and guard it started with.
      deps.state.track(created.sessionId, {
        taskId: input.taskId ?? null,
        billing: input.billing,
        permissionMode: input.permissionMode,
        guard: guard ?? null,
      });
      if (input.taskId) {
        deps.taskIds.set(created.sessionId, input.taskId);
      }
      void deps.announceSession(created.sessionId).catch(() => undefined);

      await dispatchTurn({
        sessionId: created.sessionId,
        content: input.prompt,
        options: {
          model: markedModel,
          effort: input.effort,
          permissionMode: input.permissionMode,
          sessionSummary: clipText(input.title ?? input.prompt, MAX_SUMMARY_LENGTH),
          ...(compiledGuard ? { toolPolicy: createToolPolicy(compiledGuard) } : {}),
        },
      });

      return {
        sessionId: created.sessionId,
        projectPath: project.project_path,
        title: input.title ? clipText(input.title, MAX_TITLE_LENGTH) : created.sessionName,
        model: input.model,
        billing: input.billing,
        permissionMode: input.permissionMode,
        taskId: input.taskId ?? null,
        status: 'running' as const,
        guarded: compiledGuard !== null,
        // Patterns that are not valid regular expressions are not enforced; say so rather than hide it.
        ...(compiledGuard ? { guard: { skippedPatterns: compiledGuard.skippedPatterns, approvalTimeoutMs: compiledGuard.approvalTimeoutMs } } : {}),
      };
    },

    /** Sends the next user message: into a held live run, or as a resume run when the session is idle. */
    async sendMessage(sessionId: string, input: { text: string; interrupt: boolean; permissionMode?: string }) {
      const { interrupted } = await sendUserTurn(sessionId, input.text, input);
      return { sessionId, accepted: true as const, interrupted };
    },

    /** The permission prompts a session is waiting on right now (so Foreman can recover after its own restart). */
    listPermissions(sessionId: string) {
      requireClaudeSession(sessionId);
      return {
        permissions: pendingApprovals(sessionId).map((pending) => ({
          requestId: pending.requestId,
          toolName: pending.toolName,
          input: summarizeToolInput(pending.input, MAX_PERMISSION_INPUT_LENGTH),
          askedAt: pending.askedAt,
        })),
      };
    },

    /**
     * Answers one of the session's pending permission prompts, the same way the chat UI does. Whoever answers first
     * wins: a prompt the UI (or a timeout, or an abort) already settled is no longer pending and answers 404.
     */
    answerPermission(sessionId: string, input: { requestId: string; decision: 'allow' | 'deny'; reason?: string }) {
      requireClaudeSession(sessionId);
      if (!pendingApprovals(sessionId).some((pending) => pending.requestId === input.requestId)) {
        throw new AppError('That permission request is not pending for this session (already answered, unknown, or the run is gone).', {
          code: 'NO_PENDING_PERMISSION',
          statusCode: 404,
        });
      }
      deps.runtime.resolvePermission(
        input.requestId,
        input.decision === 'allow'
          ? { allow: true }
          : { allow: false, message: input.reason ?? 'Denied by the Foreman supervisor.' },
      );
      return { resolved: true as const };
    },

    /** Stops the session's run the way the UI's Stop button does (the live process is ended too). */
    async interrupt(sessionId: string) {
      requireClaudeSession(sessionId);
      const wasRunning = deps.runs.isProcessing(sessionId);
      const hadLiveProcess = deps.runtime.isLive(sessionId);
      if (!wasRunning && !hadLiveProcess) {
        throw new AppError('The session has no active run to interrupt.', { code: 'NOT_RUNNING', statusCode: 409 });
      }
      const aborted = await deps.runtime.abort(sessionId);
      // Same follow-up as the UI's `chat.abort`: end the run record so watching clients see it stop.
      deps.runs.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
      return { sessionId, interrupted: aborted, wasRunning, hadLiveProcess };
    },

    /**
     * Switches the model. The change is recorded on the session (so every later resume keeps it) and,
     * when a process is live, applied to it immediately. Billing stays as the session started: it is
     * fixed when the process starts, so an `@api` marker in `model` is ignored.
     */
    async setModel(sessionId: string, model: string) {
      const session = requireClaudeSession(sessionId);
      const { billing } = splitModelBilling(session.model);
      const plain = splitModelBilling(model).model;
      if (!plain) {
        throw new AppError('model is required.', { code: 'INVALID_MODEL', statusCode: 400 });
      }

      deps.setSessionModel(sessionId, applyModelBilling(plain, billing));
      const appliedLive = deps.runtime.isLive(sessionId) ? await deps.runtime.setModel(sessionId, plain) : false;
      return { sessionId, model: plain, billing, applied: appliedLive ? ('live' as const) : ('next_run' as const) };
    },

    /**
     * Compacts the conversation by sending `/compact [instructions]` as a user turn. The CLI runs
     * slash commands found in the prompt stream, so this behaves like typing the command in the UI.
     */
    async compact(sessionId: string, instructions: string | undefined, options: { permissionMode?: string } = {}) {
      const command = instructions ? `/compact ${instructions}` : '/compact';
      await sendUserTurn(sessionId, command, { interrupt: false, ...options });
      return { sessionId, accepted: true as const, command: clipText(command, 200) };
    },
  };
}

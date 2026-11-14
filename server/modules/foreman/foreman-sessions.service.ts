import type { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { applyModelBilling, splitModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import { isNarrowerOrEqual, ownerTurnSettings } from '@/modules/foreman/foreman-owner-settings.service.js';
import type { ForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';
import type { ForemanSessionReadsService } from '@/modules/foreman/foreman-session-reads.service.js';
import { isSandboxedSession, requireSandboxedMode } from '@/modules/foreman/foreman-session-sandbox.service.js';
import { createForemanSessionStart } from '@/modules/foreman/foreman-session-start.service.js';
import type { ForemanSessionState, ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import { awaitTurnAdmission } from '@/modules/foreman/foreman-turn-admission.service.js';
import type { ForemanOwnerSettings } from '@/shared/types.js';
import { AppError, clipText, summarizeToolInput } from '@/shared/utils.js';

/** The options of a turn the bridge dispatches: the settings the UI sends with every turn, and the marks of the bridge's runs. */
type ForemanTurnOptions = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** The owner's tools on a session handed over, in the shape the UI sends them, so the runtime applies them exactly as for the owner. */
  toolsSettings?: { allowedTools: string[]; disallowedTools: string[]; skipPermissions: false };
  sessionSummary: string;
  /** Set on every run the bridge dispatches: the runtime reports it, and such a run never counts as the owner's (foreman-run-modes.service.ts). */
  foremanDispatch: true;
  /**
   * Set on every run of a sandboxed session. The Claude runtime passes it to the sandbox provider as `required`: such a run is refused
   * when its sandbox cannot be found, while a run without it (a person typing in the UI) is never refused for that.
   */
  foremanSandbox?: true;
};

type StartTurnInput = {
  sessionId: string;
  content: string;
  options: ForemanTurnOptions;
  interruptActiveRun?: boolean;
};

/**
 * What the sessions service needs from the rest of cloudcli, injected so it can be tested without a database, a websocket server,
 * or a Claude process. `foreman.module.ts` wires the production implementations.
 */
// Consumed by foreman.module.ts, which wires the production implementations, by foreman-session-start.service.ts (its slice) and by the
// route tests' world.
export type ForemanSessionsDependencies = {
  /** The session lookup and the pending permission prompts, shared with the reads and the hand-over. */
  reads: Pick<ForemanSessionReadsService, 'requireClaudeSession' | 'pendingApprovals'>;
  sessionsDb: Pick<typeof sessionsDb, 'updateSessionCustomName' | 'getSessionById'>;
  projectsDb: Pick<typeof projectsDb, 'getProjectPath'>;
  /** Allocates the stable app session id for a brand-new Claude chat (the UI's `POST /api/providers/sessions`). */
  createAppSession(projectPath: string, initialMessage: string): { sessionId: string; sessionName: string };
  /** Takes a session out of every listing: `delete` drops the row of one that never ran, `archive` hides one that did, as the UI's own delete does. */
  removeSession(sessionId: string, how: 'delete' | 'archive'): Promise<void>;
  /** Starts a turn exactly like the UI's `chat.send` with no socket attached; settles when the turn's run ends. */
  startTurn(input: StartTurnInput): Promise<{ started: boolean; error: string | null }>;
  runs: {
    isProcessing(sessionId: string): boolean;
    completeRun(sessionId: string, options: { exitCode: number; aborted: boolean }): void;
  };
  runtime: {
    abort(sessionId: string): Promise<boolean>;
    isLive(sessionId: string): boolean;
    /** Answers a pending permission prompt, exactly like the chat UI's `chat.permission-response`. */
    resolvePermission(requestId: string, decision: { allow: boolean; message?: string }): void;
    setModel(sessionId: string, model: string): Promise<boolean>;
    hasApiKey(): boolean;
  };
  /** Records the model a session runs with (so resumed runs keep it). */
  setSessionModel(sessionId: string, model: string): void;
  /** Status, permission mode and sandbox of the sessions the bridge starts or drives; survives restarts. */
  state: Pick<ForemanSessionStateService, 'get' | 'track' | 'trackStrict' | 'sandboxOf'>;
  /** What the owner's last own run of each session started with (an adopted session's turns are narrowed by it), and the latest run of any origin. */
  runModes: Pick<ForemanRunModes, 'settingsOf' | 'latestRunOf'>;
  /** The commit a project is at (`git rev-parse HEAD`), or null when it has none or is no repository. */
  headOf(projectPath: string): Promise<string | null>;
  /** The git directory a project's worktrees share (`git rev-parse --git-common-dir`), or null when it is no repository. */
  gitCommonDirOf(projectPath: string): Promise<string | null>;
  /** Remembers which Foreman task a session belongs to; a start that fails forgets it again. */
  taskIds: { set(sessionId: string, taskId: string): void; forget(sessionId: string): void };
  /** Marks sessions started through the bridge, so the runtime gives them the worker autocompact threshold; a start that fails unmarks it. */
  managed?: { mark(sessionId: string): void; unmark(sessionId: string): void };
  /** Tells connected UIs about a session so it appears in the sidebar immediately. */
  announceSession(sessionId: string): Promise<void>;
  /** How long a started turn is watched for an immediate refusal or failure before the call returns. */
  admissionWindowMs?: number;
  /** Where a step that could not be taken is reported (the clean-up after a failed start); never throws. */
  log?: (message: string) => void;
};

const DEFAULT_ADMISSION_WINDOW_MS = 50;
const MAX_SUMMARY_LENGTH = 80;
const MAX_PERMISSION_INPUT_LENGTH = 1000;

/**
 * Drives the sessions Foreman supervises: starting one, sending its turns, answering its permission prompts, stopping it and changing its
 * model. Every send, start and stop goes through the same code the UI uses, so a Foreman-driven session behaves (and appears) exactly like one
 * a person started. What a session is (listing, status, events, digest, context) is the reads service's, and the hand-over is its own service.
 */
// Consumed by foreman.routes.ts, which parses requests and calls these operations.
export function createForemanSessionsService(deps: ForemanSessionsDependencies) {
  const admissionWindowMs = deps.admissionWindowMs ?? DEFAULT_ADMISSION_WINDOW_MS;

  /** The state of a session Foreman supervises; any other session (never adopted, or released) is not Foreman's to drive. */
  function requireSupervised(sessionId: string): ForemanSessionState {
    const state = deps.state.get(sessionId);
    if (!state || state.supervision === 'released') {
      throw new AppError('Foreman does not supervise this session: start it through the bridge or adopt it first.', {
        code: 'NOT_SUPERVISED',
        statusCode: 409,
      });
    }
    return state;
  }

  /**
   * The settings a turn of an adopted session runs with: the owner's base settings, narrowed by the owner's latest own run (`ownerTurnSettings`).
   * A session adopted before they were stored has no base, and its turns are refused rather than run with defaults that are not the owner's.
   */
  function ownerSettingsOf(state: ForemanSessionState): ForemanOwnerSettings {
    if (!state.permissionMode || !state.ownerTools) {
      throw new AppError('This session was handed over before its owner\'s permission mode and tools were recorded: release it, and the owner hands it over again.', {
        code: 'PERMISSION_MODE_UNKNOWN',
        statusCode: 409,
      });
    }
    return ownerTurnSettings({ permissionMode: state.permissionMode, ...state.ownerTools }, deps.runModes.settingsOf(state.sessionId));
  }

  /**
   * Refuses a turn of an adopted session while its CLI process is live with settings wider than `effective` (or not known): a turn sent then
   * joins that process (one held open for background work) and runs with the settings that started it, not with the ones it carries.
   */
  function requireLiveRunWithin(sessionId: string, effective: ForemanOwnerSettings): void {
    if (!deps.runtime.isLive(sessionId)) {
      return;
    }
    const live = deps.runModes.latestRunOf(sessionId);
    if (!live || !isNarrowerOrEqual(live, effective)) {
      throw new AppError(
        'The session\'s CLI process is still live and was started with wider settings than its owner now allows; a turn sent now would run with them. Retry once the process has ended, interrupt it first, or let the owner\'s run finish.',
        { code: 'SETTINGS_WIDER_THAN_OWNERS', statusCode: 409 },
      );
    }
  }

  /** Starts a turn and waits only long enough to report an immediate refusal or startup failure. */
  const dispatchTurn = (input: StartTurnInput): Promise<void> => awaitTurnAdmission(input.sessionId, deps.startTurn(input), admissionWindowMs);
  const start = createForemanSessionStart(deps, dispatchTurn);

  async function sendUserTurn(
    sessionId: string,
    text: string,
    options: { interrupt: boolean; permissionMode?: string },
  ): Promise<{ interrupted: boolean }> {
    const session = deps.reads.requireClaudeSession(sessionId);
    // First of all: nothing about a session Foreman does not supervise (not even whether it is running) is answered to the bridge.
    // A resumed run (after a restart too) keeps the permission mode Foreman chose; its sandbox is read from the stored state when the run starts.
    // A session handed over runs with its owner's mode and tools (stored at adoption, narrowed by the owner's later own runs): Foreman cannot change them.
    const state = requireSupervised(sessionId);
    if (state.supervision === 'adopted' && options.permissionMode) {
      throw new AppError('A session handed over keeps its owner\'s permission mode: permissionMode cannot be set.', { code: 'PERMISSION_MODE_LOCKED', statusCode: 400 });
    }
    const owner = state.supervision === 'adopted' ? ownerSettingsOf(state) : null;
    const sandboxed = isSandboxedSession(state);
    if (sandboxed) {
      requireSandboxedMode(options.permissionMode);
    }
    const processing = deps.runs.isProcessing(sessionId);
    if (processing && !options.interrupt) {
      throw new AppError(
        'A turn is already running for this session. Wait for turn_end, call interrupt, or send with "interrupt": true.',
        { code: 'RUN_IN_PROGRESS', statusCode: 409 },
      );
    }
    if (owner) {
      requireLiveRunWithin(sessionId, owner);
    }
    if (!deps.runtime.isLive(sessionId) && splitModelBilling(session.model).billing === 'api-key' && !deps.runtime.hasApiKey()) {
      throw new AppError('This session is billed to the API key, but no API key file is available.', {
        code: 'API_KEY_UNAVAILABLE',
        statusCode: 503,
      });
    }

    const permissionMode = owner?.permissionMode ?? options.permissionMode ?? state.permissionMode ?? undefined;
    if (options.permissionMode && options.permissionMode !== state.permissionMode) {
      deps.state.track(sessionId, { permissionMode: options.permissionMode });
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
        ...(owner ? { toolsSettings: { allowedTools: owner.allowedTools, disallowedTools: owner.disallowedTools, skipPermissions: false as const } } : {}),
        sessionSummary: clipText(text, MAX_SUMMARY_LENGTH),
        foremanDispatch: true,
        ...(sandboxed ? { foremanSandbox: true as const } : {}),
      },
    });
    return { interrupted };
  }

  return {
    /** Where a session started in a project would work, for checking its sandbox policy before anything is made. */
    sandboxScopeOf: start.sandboxScopeOf,

    /** Starts a new sandboxed Claude session and its first turn; a start that fails leaves no session behind. */
    startSession: start.startSession,

    /** Sends the next user message: into a held live run, or as a resume run when the session is idle. */
    async sendMessage(sessionId: string, input: { text: string; interrupt: boolean; permissionMode?: string }) {
      const { interrupted } = await sendUserTurn(sessionId, input.text, input);
      return { sessionId, accepted: true as const, interrupted };
    },

    /** The permission prompts a session is waiting on right now (so Foreman can recover after its own restart). */
    listPermissions(sessionId: string) {
      deps.reads.requireClaudeSession(sessionId);
      return {
        permissions: deps.reads.pendingApprovals(sessionId).map((pending) => ({
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
      deps.reads.requireClaudeSession(sessionId);
      requireSupervised(sessionId);
      if (!deps.reads.pendingApprovals(sessionId).some((pending) => pending.requestId === input.requestId)) {
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
      deps.reads.requireClaudeSession(sessionId);
      requireSupervised(sessionId);
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
     * when a process is live, applied to it immediately. Billing stays as the session started (`cap` stays `cap`): it is
     * fixed when the process starts, so an `@api` or `@cap` marker in `model` is ignored.
     */
    async setModel(sessionId: string, model: string) {
      const session = deps.reads.requireClaudeSession(sessionId);
      if (requireSupervised(sessionId).supervision === 'adopted') {
        throw new AppError('A session handed over keeps its owner\'s model.', { code: 'MODEL_LOCKED', statusCode: 409 });
      }
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

export type ForemanSessionsService = ReturnType<typeof createForemanSessionsService>;

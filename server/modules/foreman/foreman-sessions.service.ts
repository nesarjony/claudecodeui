import { isDeepStrictEqual } from 'node:util';

import type { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { applyModelBilling, splitModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import type { ForemanSessionReadsService } from '@/modules/foreman/foreman-session-reads.service.js';
import type { ForemanSessionState, ForemanSessionStatePatch, ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanBilling } from '@/shared/types.js';
import { AppError, clipText, isSandboxedPermissionMode, SANDBOXED_PERMISSION_MODES, summarizeToolInput } from '@/shared/utils.js';

/** The options of a turn the bridge dispatches: the settings the UI sends with every turn, and the mark of a sandboxed session's run. */
type ForemanTurnOptions = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  sessionSummary: string;
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
// Consumed by foreman.module.ts, which wires the production implementations, and by the route tests' world.
export type ForemanSessionsDependencies = {
  /** The session lookup and the pending permission prompts, shared with the reads and the hand-over. */
  reads: Pick<ForemanSessionReadsService, 'requireClaudeSession' | 'pendingApprovals'>;
  sessionsDb: Pick<typeof sessionsDb, 'updateSessionCustomName'>;
  projectsDb: Pick<typeof projectsDb, 'getProjectPath'>;
  /** Allocates the stable app session id for a brand-new Claude chat (the UI's `POST /api/providers/sessions`). */
  createAppSession(projectPath: string, initialMessage: string): { sessionId: string; sessionName: string };
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
  /** The commit a project is at (`git rev-parse HEAD`), or null when it has none or is no repository. */
  headOf(projectPath: string): Promise<string | null>;
  /** Remembers which Foreman task a session belongs to. */
  taskIds: { set(sessionId: string, taskId: string): void };
  /** Marks sessions started through the bridge, so the runtime gives them the worker autocompact threshold. */
  managed?: { mark(sessionId: string): void };
  /** Tells connected UIs about a session so it appears in the sidebar immediately. */
  announceSession(sessionId: string): Promise<void>;
  /** How long a started turn is watched for an immediate refusal or failure before the call returns. */
  admissionWindowMs?: number;
};

const DEFAULT_ADMISSION_WINDOW_MS = 50;
const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 80;
const MAX_PERMISSION_INPUT_LENGTH = 1000;

/** Every session Foreman started runs sandboxed (a stored policy says so too); one handed over runs as its owner set it up. */
const isSandboxed = (state: ForemanSessionState): boolean => state.supervision === 'started' || state.sandboxJson !== null;

/**
 * Refuses a permission mode a sandboxed session may not run in. The sandbox isolates Bash only; the file tools are held by the prompts that
 * `bypassPermissions` skips and `auto` hands to a classifier.
 */
function requireSandboxedMode(permissionMode: string | undefined): void {
  if (permissionMode !== undefined && !isSandboxedPermissionMode(permissionMode)) {
    throw new AppError(
      `permissionMode "${permissionMode}" is not allowed for a sandboxed session: the sandbox covers Bash only and the file tools rely on the prompts it would skip. Use one of: ${SANDBOXED_PERMISSION_MODES.join(', ')}.`,
      { code: 'PERMISSION_MODE_FORBIDDEN', statusCode: 400 },
    );
  }
}

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
   * Records a session this bridge starts, with its sandbox, before its first run: with a write that throws when it fails, then read back
   * the way every run of the session reads it. Anything but exactly the policy that was sent stops the start, because the session's runs
   * would not find their sandbox.
   */
  function recordSandboxedStart(sessionId: string, patch: ForemanSessionStatePatch & { sandbox: ForemanSandboxPolicy }): void {
    const notRecorded = (reason: string) =>
      new AppError(`The sandbox of the session was not recorded (${reason}), so nothing was run.`, { code: 'SANDBOX_NOT_RECORDED', statusCode: 500 });
    try {
      deps.state.trackStrict(sessionId, patch);
    } catch (error) {
      throw notRecorded(`the write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const readBack = deps.state.sandboxOf(sessionId, { required: true });
    if (!readBack || !('policy' in readBack) || !isDeepStrictEqual(readBack.policy, patch.sandbox)) {
      throw notRecorded('what is stored does not read back as the policy that was sent');
    }
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
    const session = deps.reads.requireClaudeSession(sessionId);
    // First of all: nothing about a session Foreman does not supervise (not even whether it is running) is answered to the bridge.
    // A resumed run (after a restart too) keeps the permission mode Foreman chose; its sandbox is read from the stored state when the run starts.
    // A session handed over keeps the owner's permission mode: Foreman cannot widen it.
    const state = requireSupervised(sessionId);
    if (state.supervision === 'adopted' && options.permissionMode) {
      throw new AppError('A session handed over keeps its owner\'s permission mode: permissionMode cannot be set.', { code: 'PERMISSION_MODE_LOCKED', statusCode: 400 });
    }
    const sandboxed = isSandboxed(state);
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
    if (!deps.runtime.isLive(sessionId) && splitModelBilling(session.model).billing === 'api-key' && !deps.runtime.hasApiKey()) {
      throw new AppError('This session is billed to the API key, but no API key file is available.', {
        code: 'API_KEY_UNAVAILABLE',
        statusCode: 503,
      });
    }

    const permissionMode = options.permissionMode ?? state.permissionMode ?? undefined;
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
        sessionSummary: clipText(text, MAX_SUMMARY_LENGTH),
        ...(sandboxed ? { foremanSandbox: true as const } : {}),
      },
    });
    return { interrupted };
  }

  return {
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
      sandbox: ForemanSandboxPolicy;
    }) {
      // Before anything is made: every session started here is sandboxed.
      requireSandboxedMode(input.permissionMode);
      const project = deps.projectsDb.getProjectPath(input.projectPath);
      if (!project || project.isArchived) {
        throw new AppError('projectPath is not a known cloudcli project.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
      }
      // Only the API-key billing needs the key file: a `cap` session starts with a placeholder key and no real credential.
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
      // Marked before the run starts, so the run that this call starts already gets the threshold.
      deps.managed?.mark(created.sessionId);
      // Recorded before the run starts, so the run that this call starts is already sandboxed and its events are the session's, and a
      // run that is resumed after a restart still has the permission mode and sandbox it started with.
      recordSandboxedStart(created.sessionId, {
        taskId: input.taskId ?? null,
        billing: input.billing,
        permissionMode: input.permissionMode,
        sandbox: input.sandbox,
        baseHead: await deps.headOf(project.project_path),
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
          foremanSandbox: true,
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
        sandboxed: true as const,
      };
    },

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

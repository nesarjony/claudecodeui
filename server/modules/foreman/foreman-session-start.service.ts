import { applyModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import { recordSandboxedStart, requireSandboxedMode } from '@/modules/foreman/foreman-session-sandbox.service.js';
import type { ForemanSessionsDependencies } from '@/modules/foreman/foreman-sessions.service.js';
import type { ForemanBilling, ForemanSandboxScope } from '@/shared/types.js';
import { AppError, clipText } from '@/shared/utils.js';

const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 80;

/** What starting a session needs: a slice of the sessions service's dependencies, and its way of dispatching a turn. */
type StartDependencies = Pick<
  ForemanSessionsDependencies,
  'sessionsDb' | 'projectsDb' | 'createAppSession' | 'runtime' | 'state' | 'headOf' | 'gitCommonDirOf' | 'taskIds' | 'managed' | 'announceSession' | 'removeSession' | 'log'
>;
type DispatchTurn = (input: Parameters<ForemanSessionsDependencies['startTurn']>[0]) => Promise<void>;

/**
 * Starting a session Foreman supervises: where it would work (for checking its sandbox), then the session itself, its sandbox and its first
 * turn. A start that fails once the session exists takes the session out of sight again, so it never leaves a live, unsupervised, empty
 * session behind.
 */
// Consumed by foreman-sessions.service.ts, whose `sandboxScopeOf` and `startSession` these are.
export function createForemanSessionStart(deps: StartDependencies, dispatchTurn: DispatchTurn) {
  const log = deps.log ?? (() => undefined);

  /**
   * Marks a session whose start failed as failed and takes it out of sight: its state says `error` and nothing supervises it (so nothing
   * drives it), its task link and worker mark go, and its row is deleted when no run ever made a transcript for it, or archived when one did.
   * Each step is tried on its own and a failing one is logged; the caller answers with the start's own error either way.
   */
  async function abandonStart(sessionId: string): Promise<void> {
    const attempt = async (what: string, step: () => void | Promise<void>) => {
      try {
        await step();
      } catch (error) {
        log(`failed start of session ${sessionId}: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await attempt('marking it failed', () => void deps.state.track(sessionId, { status: 'error', supervision: 'released' }));
    await attempt('dropping its task link', () => deps.taskIds.forget(sessionId));
    await attempt('dropping its worker mark', () => deps.managed?.unmark(sessionId));
    await attempt('removing it', async () => {
      const session = deps.sessionsDb.getSessionById(sessionId);
      if (session) {
        await deps.removeSession(sessionId, session.provider_session_id || session.jsonl_path ? 'archive' : 'delete');
      }
    });
  }

  return {
    /**
     * Where a session started in `projectPath` would work, for checking its sandbox policy: the known project and its shared git directory.
     * Git is asked only about a known project; for any other path the start is refused anyway (UNKNOWN_PROJECT).
     */
    async sandboxScopeOf(projectPath: string): Promise<ForemanSandboxScope> {
      const project = deps.projectsDb.getProjectPath(projectPath);
      if (!project || project.isArchived) {
        return { projectPath, gitCommonDir: null };
      }
      return { projectPath: project.project_path, gitCommonDir: await deps.gitCommonDirOf(project.project_path) };
    },

    /**
     * Starts a new Claude session in a known project and sends its first prompt, through the same path as the UI. The session id is
     * allocated immediately; the run continues in the background. A failure after the session was allocated (its sandbox not recorded, its
     * turn refused, anything thrown) answers with that failure and leaves no session behind (`abandonStart`).
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
      /** What `sandbox` was checked against (`sandboxScopeOf` of the same project); stored with it. */
      sandboxScope: ForemanSandboxScope;
    }) {
      // Before anything is made: every session started here is sandboxed.
      requireSandboxedMode(input.permissionMode);
      const project = deps.projectsDb.getProjectPath(input.projectPath);
      if (!project || project.isArchived) {
        throw new AppError('projectPath is not a known cloudcli project.', { code: 'UNKNOWN_PROJECT', statusCode: 422 });
      }
      if (input.sandboxScope.projectPath !== project.project_path) {
        throw new AppError('sandbox was checked against another project than the one the session starts in.', { code: 'SANDBOX_INVALID', statusCode: 400 });
      }
      // Only the API-key billing needs the key file: a `cap` session starts with a placeholder key and no real credential.
      if (input.billing === 'api-key' && !deps.runtime.hasApiKey()) {
        throw new AppError('API-key billing was requested, but no API key file is available.', {
          code: 'API_KEY_UNAVAILABLE',
          statusCode: 503,
        });
      }

      const created = deps.createAppSession(project.project_path, input.title ?? input.prompt);
      try {
        if (input.title) {
          deps.sessionsDb.updateSessionCustomName(created.sessionId, clipText(input.title, MAX_TITLE_LENGTH));
        }
        // Marked before the run starts, so the run that this call starts already gets the threshold.
        deps.managed?.mark(created.sessionId);
        // Recorded before the run starts, so the run that this call starts is already sandboxed and its events are the session's, and a
        // run that is resumed after a restart still has the permission mode and sandbox it started with.
        recordSandboxedStart(deps.state, created.sessionId, {
          taskId: input.taskId ?? null,
          billing: input.billing,
          permissionMode: input.permissionMode,
          sandbox: { policy: input.sandbox, scope: input.sandboxScope },
          baseHead: await deps.headOf(project.project_path),
        });
        if (input.taskId) {
          deps.taskIds.set(created.sessionId, input.taskId);
        }
        await dispatchTurn({
          sessionId: created.sessionId,
          content: input.prompt,
          options: {
            model: applyModelBilling(input.model, input.billing),
            effort: input.effort,
            permissionMode: input.permissionMode,
            sessionSummary: clipText(input.title ?? input.prompt, MAX_SUMMARY_LENGTH),
            foremanSandbox: true,
          },
        });
      } catch (error) {
        await abandonStart(created.sessionId);
        throw error;
      }
      // Announced once the turn is under way, so a start that fails shows nothing in the sidebar.
      void deps.announceSession(created.sessionId).catch(() => undefined);

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
  };
}

import { splitModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanSessionReadsService } from '@/modules/foreman/foreman-session-reads.service.js';
import type { ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanBridgeEvent } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** What the hand-over needs from the rest of cloudcli, injected so it can be tested without a database or a Claude process. */
// Consumed by foreman.module.ts, which wires the production implementations, and by the route tests' world.
export type ForemanHandoverDependencies = {
  /** The session lookup and the state answer that adopt and release end with. */
  reads: Pick<ForemanSessionReadsService, 'requireClaudeSession' | 'getState'>;
  /** Where supervision (started, adopted, released) and the starting commit of a session are remembered; survives restarts. */
  state: Pick<ForemanSessionStateService, 'get' | 'track'>;
  /** The event log of the sessions Foreman supervises; an adopted session's events are counted from its last sequence. */
  events: { last(sessionId: string): ForemanBridgeEvent | null };
  /** The commit a project is at (`git rev-parse HEAD`), or null when it has none or is no repository. */
  headOf(projectPath: string): Promise<string | null>;
  /** Resolves when the runtime events seen so far are stored, so a release leaves no event of the supervised time behind. */
  settleEvents(): Promise<void>;
  /** Remembers which Foreman task a session belongs to. */
  taskIds: { set(sessionId: string, taskId: string): void };
};

/**
 * The hand-over (BR-2.10): the owner gives one of their own sessions to Foreman (`adopt`) and takes it back (`release`). Neither changes the
 * session's model, routing or permissions; they only change whether Foreman supervises it.
 */
// Consumed by foreman.routes.ts, which parses the requests and calls these two operations.
export function createForemanHandoverService(deps: ForemanHandoverDependencies) {
  return {
    /**
     * The session the owner hands over joins Foreman's supervision as it is: its model, routing and permission mode are not touched and no
     * sandbox is added. From here its events are stored and pushed like a worker's, counting commits from where the project is now, and
     * messages, interrupts and permission answers work for it.
     */
    async adopt(sessionId: string, input: { taskId?: string }) {
      const session = deps.reads.requireClaudeSession(sessionId);
      const supervision = deps.state.get(sessionId)?.supervision;
      if (supervision === 'started' || supervision === 'adopted') {
        throw new AppError('Foreman already supervises this session.', { code: 'ALREADY_SUPERVISED', statusCode: 409 });
      }
      deps.state.track(sessionId, {
        supervision: 'adopted',
        taskId: input.taskId ?? null,
        billing: splitModelBilling(session.model).billing,
        baseHead: session.project_path ? await deps.headOf(session.project_path) : null,
        baseSequence: deps.events.last(sessionId)?.sequence ?? 0,
      });
      if (input.taskId) {
        deps.taskIds.set(sessionId, input.taskId);
      }
      const { model, billing } = splitModelBilling(session.model);
      return { ...deps.reads.getState(sessionId), projectPath: session.project_path, model, billing };
    },

    /** Ends the hand-over: nothing more is stored or pushed for the session (what is already stored is still pushed), and the session carries on as the owner's own. */
    async release(sessionId: string) {
      deps.reads.requireClaudeSession(sessionId);
      if (deps.state.get(sessionId)?.supervision !== 'adopted') {
        throw new AppError('Only a session that was handed over can be released.', { code: 'NOT_ADOPTED', statusCode: 409 });
      }
      await deps.settleEvents();
      deps.state.track(sessionId, { supervision: 'released' });
      return deps.reads.getState(sessionId);
    },
  };
}

export type ForemanHandoverService = ReturnType<typeof createForemanHandoverService>;

import type { foremanHandoverGrantsDb } from '@/modules/database/index.js';
import { splitModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';
import type { ForemanSessionReadsService } from '@/modules/foreman/foreman-session-reads.service.js';
import type { ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import type { ForemanBridgeEvent } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** How long an owner's grant can be used: Foreman adopts within this window, or the owner grants again. */
// Consumed by the hand-over route tests, which move their clock past it.
export const HANDOVER_GRANT_TTL_MS = 5 * 60_000;

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
  /** What the owner's last run of each session started with: an adopted session's turns never go beyond it. */
  runModes: Pick<ForemanRunModes, 'settingsOf'>;
  /** The owners' grants (`foreman_handover_grants`): recorded by the logged-in owner, used up by `adopt`. */
  grants: Pick<typeof foremanHandoverGrantsDb, 'put' | 'consume' | 'revoke' | 'purgeExpired'>;
  /** The clock grants are issued and checked against. */
  now?: () => Date;
};

/**
 * The hand-over (BR-2.10): the owner gives one of their own sessions to Foreman and takes it back. The owner first grants it while logged in
 * to cloudcli (`grant`, from the UI router only: the bridge has no route to it, so the bridge token alone never hands a session over); Foreman
 * then adopts it (`adopt`), which uses the grant up, and releases it (`release`). None of this changes the session's model, routing,
 * permission mode or tools; it only changes whether Foreman supervises the session.
 */
// Consumed by foreman.routes.ts (adopt, release, for Foreman) and foreman-ui.routes.ts (grant, revoke, for the logged-in owner).
export function createForemanHandoverService(deps: ForemanHandoverDependencies) {
  const now = deps.now ?? (() => new Date());

  /** A session Foreman supervises already is neither the owner's to hand over nor Foreman's to take again. */
  function requireUnsupervised(sessionId: string): void {
    const supervision = deps.state.get(sessionId)?.supervision;
    if (supervision === 'started' || supervision === 'adopted') {
      throw new AppError('Foreman already supervises this session.', { code: 'ALREADY_SUPERVISED', statusCode: 409 });
    }
  }

  return {
    /** The owner (`grantedBy`, the logged-in user) lets Foreman adopt the session once, within HANDOVER_GRANT_TTL_MS. A new grant replaces an older one. */
    grant(sessionId: string, grantedBy: string) {
      deps.reads.requireClaudeSession(sessionId);
      requireUnsupervised(sessionId);
      const grantedAt = now();
      deps.grants.purgeExpired(grantedAt.toISOString());
      const expiresAt = new Date(grantedAt.getTime() + HANDOVER_GRANT_TTL_MS).toISOString();
      deps.grants.put({ session_id: sessionId, granted_by: grantedBy, created_at: grantedAt.toISOString(), expires_at: expiresAt });
      return { sessionId, expiresAt };
    },

    /** The owner withdraws a grant Foreman has not used; `revoked` is false when there was none. */
    revoke(sessionId: string) {
      return { sessionId, revoked: deps.grants.revoke(sessionId) };
    },

    /**
     * The session the owner granted joins Foreman's supervision as it is: its model and routing are not touched, no sandbox is added, and
     * the permission mode and tool lists the owner's last run started with are stored as the owner's base settings, which every turn Foreman
     * sends runs with (narrowed by the owner's later own runs, never widened). From here its events are stored and pushed like a worker's,
     * counting commits from where the project is now, and messages, interrupts and permission answers work for it.
     */
    async adopt(sessionId: string, input: { taskId?: string }) {
      const session = deps.reads.requireClaudeSession(sessionId);
      requireUnsupervised(sessionId);
      // Foreman never runs with more than the owner, so without the owner's recorded settings it does not guess (a default could widen
      // them). Refused before the grant is touched, so the owner's grant still holds for the retry.
      const owner = deps.runModes.settingsOf(sessionId);
      if (!owner) {
        throw new AppError('The owner\'s permission mode and tools for this session are not known yet: the owner sends one turn in it, then Foreman adopts it.', {
          code: 'PERMISSION_MODE_UNKNOWN',
          statusCode: 409,
        });
      }
      // Used up last, right before anything is recorded, in one atomic step: of two adopts racing for a grant one goes on. Nothing in
      // between yields, so the checks above still hold. A failure after this point loses the grant: the owner grants again.
      if (!deps.grants.consume(sessionId, now().toISOString())) {
        throw new AppError('The owner has not handed this session over: they grant it in cloudcli, and the grant is used once and expires after five minutes.', {
          code: 'HANDOVER_NOT_GRANTED',
          statusCode: 403,
        });
      }
      const { permissionMode, allowedTools, disallowedTools } = owner.settings;
      deps.state.track(sessionId, {
        supervision: 'adopted',
        permissionMode,
        ownerTools: { allowedTools, disallowedTools, adoptedAt: now().toISOString() },
        taskId: input.taskId ?? null,
        billing: splitModelBilling(session.model).billing,
        baseHead: session.project_path ? await deps.headOf(session.project_path) : null,
        baseSequence: deps.events.last(sessionId)?.sequence ?? 0,
      });
      if (input.taskId) {
        deps.taskIds.set(sessionId, input.taskId);
      }
      const { model, billing } = splitModelBilling(session.model);
      return { ...deps.reads.getState(sessionId), projectPath: session.project_path, model, billing, permissionMode };
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

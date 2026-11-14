import type { ForemanCommits } from '@/modules/foreman/foreman-commits.service.js';
import { translateRuntimeEvent } from '@/modules/foreman/foreman-event-translate.service.js';
import type { ForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

// A refusal can be reported twice (the refused assistant message and the structured `model_refusal_*` notice): one event per
// session within this window is enough.
const REFUSAL_DEDUPE_MS = 30_000;

/**
 * Turns the runtime events of the sessions Foreman supervises into stored events, in the order they happened.
 *
 * `handle` returns at once and never throws (it runs inside the runtime loop): events go through one queue, because working out a
 * turn's commits asks git and a later event must not overtake an earlier one. Each stored event is announced to `onStored`, which
 * starts the push. Events of a session Foreman does not supervise are ignored.
 */
// Consumed by foreman.module.ts, which subscribes it to the Claude runtime's event stream.
export function createForemanEventRecorder(dependencies: {
  store: Pick<ForemanEventStore, 'append' | 'reportedCommits'>;
  commits: Pick<ForemanCommits, 'commitsSince'>;
  /** Where supervision of the session began; null for a session Foreman does not supervise (never did, or released it). */
  startOf: (sessionId: string) => { baseHead: string | null; baseSequence: number } | null;
  onStored: () => void;
  now?: () => Date;
  log?: (message: string) => void;
}) {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? (() => undefined);
  const lastRefusalAt = new Map<string, number>();
  // Sessions whose turn gave up on a 429 (a `quota` event was stored): the failure that follows from it is not reported again.
  const quotaTurns = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  /** The commits of the turn that just ended: everything committed since the session started, less what earlier turns reported. */
  async function commitsThisTurn(event: ClaudeRuntimeEvent, start: { baseHead: string | null; baseSequence: number }): Promise<number> {
    if (!start.baseHead || !event.projectPath) {
      return 0;
    }
    const total = await dependencies.commits.commitsSince(event.projectPath, start.baseHead);
    return total === null ? 0 : Math.max(0, total - dependencies.store.reportedCommits(event.sessionId, start.baseSequence));
  }

  async function record(event: ClaudeRuntimeEvent): Promise<void> {
    const session = dependencies.startOf(event.sessionId);
    if (!session) {
      return;
    }
    if (event.kind === 'run_started') {
      quotaTurns.delete(event.sessionId);
    }
    const commitCount = event.kind === 'turn_result' ? await commitsThisTurn(event, session) : 0;
    const body = translateRuntimeEvent(event, { commitCount });
    if (!body) {
      return;
    }
    if (body.kind === 'quota') {
      quotaTurns.add(event.sessionId);
    } else if (body.kind === 'turn_end') {
      quotaTurns.delete(event.sessionId);
    } else if (quotaTurns.has(event.sessionId) && (body.kind === 'error' || (body.kind === 'session_end' && body.payload.reason === 'crashed'))) {
      // What the quota already explains: the failed turn, the CLI exiting after it, and that run ending. Foreman pauses; it does not recover from a crash.
      if (body.kind === 'session_end') quotaTurns.delete(event.sessionId);
      return;
    }
    if (body.kind === 'refusal') {
      const at = now().getTime();
      const previous = lastRefusalAt.get(event.sessionId);
      if (previous !== undefined && at - previous < REFUSAL_DEDUPE_MS) {
        return;
      }
      lastRefusalAt.set(event.sessionId, at);
    }
    dependencies.store.append(event.sessionId, body);
    dependencies.onStored();
  }

  return {
    handle(event: ClaudeRuntimeEvent): void {
      if (!event.sessionId) {
        return;
      }
      queue = queue.then(() => record(event)).catch((error: unknown) => {
        log(`event of session ${event.sessionId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    },

    /**
     * Resolves when everything handled so far is stored. The hand-over's release waits on it (through the module's `settleEvents`), so no
     * event of the supervised time is left behind a release; the pipeline tests wait on it too.
     */
    whenIdle: (): Promise<void> => queue,
  };
}

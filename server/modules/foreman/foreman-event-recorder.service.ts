import type { ForemanCommits } from '@/modules/foreman/foreman-commits.service.js';
import { translateRuntimeEvent } from '@/modules/foreman/foreman-event-translate.service.js';
import type { ForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

// A refusal can be reported twice (the refused assistant message and the structured `model_refusal_*` notice): one event per
// session within this window is enough.
const REFUSAL_DEDUPE_MS = 30_000;

// What an event that does not end a turn says about the repository: nothing.
const NO_REPOSITORY_FACTS = { commitCount: 0, headSha: null };

/**
 * Turns the runtime events of the sessions Foreman supervises into stored events, in the order they happened.
 *
 * `handle` returns at once and never throws (it runs inside the runtime loop). Working out a turn's head and commits asks git, and a
 * later event of the same session must not overtake it, so each session has its own queue: a slow git call of one session holds back
 * that session's later events and no other session's. Each stored event is announced to `onStored`, which starts the push. Events of
 * a session Foreman does not supervise are ignored.
 *
 * Between the runtime event and the stored event everything is in memory: an event still queued when cloudcli dies is lost (see
 * `docs/foreman-bridge.md`, which tells Foreman to reconcile a session that is idle without a `turn_end`).
 */
// Consumed by foreman.module.ts, which subscribes it to the Claude runtime's event stream.
export function createForemanEventRecorder(dependencies: {
  store: Pick<ForemanEventStore, 'append' | 'reportedCommits'>;
  commits: Pick<ForemanCommits, 'standing'>;
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
  // The tail of each session's queue. A session's entry is dropped once that tail has settled, so the map holds only sessions with work pending.
  const queues = new Map<string, Promise<void>>();

  /** What the repository says when the turn that just ended is over: where HEAD is, and the commits made since supervision began, less what earlier turns reported. */
  async function repositoryAfterTurn(event: ClaudeRuntimeEvent, start: { baseHead: string | null; baseSequence: number }): Promise<{ commitCount: number; headSha: string | null }> {
    if (!event.projectPath) {
      return NO_REPOSITORY_FACTS;
    }
    const { head, commitsSinceBase } = await dependencies.commits.standing(event.projectPath, start.baseHead);
    const commitCount = commitsSinceBase === null ? 0 : Math.max(0, commitsSinceBase - dependencies.store.reportedCommits(event.sessionId, start.baseSequence));
    return { commitCount, headSha: head };
  }

  async function record(event: ClaudeRuntimeEvent): Promise<void> {
    const session = dependencies.startOf(event.sessionId);
    if (!session) {
      return;
    }
    if (event.kind === 'run_started') {
      quotaTurns.delete(event.sessionId);
    }
    const body = translateRuntimeEvent(event, event.kind === 'turn_result' ? await repositoryAfterTurn(event, session) : NO_REPOSITORY_FACTS);
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
      const { sessionId } = event;
      if (!sessionId) {
        return;
      }
      const tail = (queues.get(sessionId) ?? Promise.resolve()).then(() => record(event)).catch((error: unknown) => {
        log(`event of session ${sessionId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
      queues.set(sessionId, tail);
      void tail.then(() => {
        // Only the newest tail ends its session's queue: an event handled meanwhile has already replaced it.
        if (queues.get(sessionId) === tail) {
          queues.delete(sessionId);
        }
      });
    },

    /**
     * Resolves when everything handled so far is stored. The hand-over's release waits on it (through the module's `settleEvents`), so no
     * event of the supervised time is left behind a release; the pipeline tests wait on it too.
     */
    whenIdle: async (): Promise<void> => {
      await Promise.all(queues.values());
    },
  };
}

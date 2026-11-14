import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import type { ForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import type { ForemanBridgeEvent } from '@/shared/types.js';

const PUSH_TIMEOUT_MS = 5000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

/**
 * Pushes stored events to Foreman's intake until it acknowledges each one.
 *
 * An event is acknowledged by any 2xx answer (Foreman answers a repeat of an event it already has with one too). Anything else, or no
 * answer, is retried with a doubling delay from one second up to a minute, for as long as it takes, a restart of cloudcli included:
 * the events still owed are read back from the store. A session's events go strictly in order, so one that is stuck holds back only
 * its own session. With no `eventsUrl` nothing is pushed; the events are still stored and Foreman can fetch them.
 */
// Consumed by foreman.module.ts, which starts it after boot and kicks it for every stored event.
export function createForemanEventPusher(dependencies: {
  store: Pick<ForemanEventStore, 'oldestUnackedPerSession' | 'markAcked'>;
  /** Foreman's intake endpoint; unset means the push is off. */
  eventsUrl: string | undefined;
  /** File holding the bearer token the intake expects; read again for every push so a rotated token needs no restart. */
  tokenFile: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? PUSH_TIMEOUT_MS;
  const now = dependencies.now ?? (() => Date.now());
  const log = dependencies.log ?? (() => undefined);
  const retries = new Map<string, { attempts: number; notBefore: number }>();
  let draining: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  async function send(event: ForemanBridgeEvent, url: string): Promise<boolean> {
    try {
      const token = await readBridgeToken(dependencies.tokenFile);
      if (!token) {
        log(`event ${event.id} not pushed: no intake token`);
        return false;
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        log(`event ${event.id} not acknowledged: HTTP ${response.status}`);
      }
      return response.ok;
    } catch (error) {
      log(`event ${event.id} not pushed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function backOff(eventId: string): void {
    const attempts = (retries.get(eventId)?.attempts ?? 0) + 1;
    retries.set(eventId, { attempts, notBefore: now() + Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS) });
  }

  async function drain(url: string): Promise<void> {
    try {
      do {
        again = false;
        for (let progressed = true; progressed; ) {
          progressed = false;
          const ready = dependencies.store.oldestUnackedPerSession().filter((event) => (retries.get(event.id)?.notBefore ?? 0) <= now());
          for (const event of ready) {
            if (await send(event, url)) {
              dependencies.store.markAcked(event.id);
              retries.delete(event.id);
              progressed = true;
            } else {
              backOff(event.id);
            }
          }
        }
      } while (again);
    } finally {
      // Cleared in the same step as the last look at `again`: a kick that lands after it starts a new drain instead of being told to wait for one that is over.
      draining = null;
    }
    scheduleRetry();
  }

  /** Wakes the push when the soonest retry is due. */
  function scheduleRetry(): void {
    const due = dependencies.store.oldestUnackedPerSession().flatMap((event) => retries.get(event.id)?.notBefore ?? []);
    if (due.length > 0) {
      timer = setTimeout(() => void kick(), Math.max(0, Math.min(...due) - now()));
      timer.unref();
    }
  }

  function kick(): Promise<void> {
    if (!dependencies.eventsUrl) {
      return Promise.resolve();
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (draining) {
      again = true;
      return draining;
    }
    const url = dependencies.eventsUrl;
    // Started in a later step, so that `draining` is set before a drain with nothing to send ends (and clears it) in the same breath.
    draining = Promise.resolve().then(() => drain(url)).catch((error: unknown) => {
      log(`event push failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return draining;
  }

  return {
    /** Pushes what is owed now and arranges for the rest to be retried; returns when this round is over (tests wait on it). */
    kick,
  };
}

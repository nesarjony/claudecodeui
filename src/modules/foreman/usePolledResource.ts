import { useCallback, useEffect, useRef, useState } from 'react';

export const POLL_INTERVAL_MS = 5000;

export type PolledResource<T> = {
  data: T | undefined;
  /** The last failure, kept next to the last good data so a blip does not blank the screen. Cleared by the next success. */
  error: Error | null;
  /** True until the first answer for the current key arrives. */
  loading: boolean;
  updatedAt: number | null;
  /** Fetches now (a no-op while disabled). Resolves when the answer is in. */
  refresh: () => Promise<void>;
};

type State<T> = { data: T | undefined; dataKey: string | undefined; error: Error | null; updatedAt: number | null };

/**
 * Keeps a server resource fresh: fetches when enabled, again every `intervalMs`, and on `refresh()`. Only one request is
 * in flight per resource (a slow answer is never overtaken by the next tick), the last good data stays on screen when a
 * request fails, and a new `key` (a different range, say) drops the data it does not belong to.
 */
export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  options: { enabled: boolean; intervalMs?: number; key?: string },
): PolledResource<T> {
  const { enabled, intervalMs = POLL_INTERVAL_MS, key = '' } = options;
  const [state, setState] = useState<State<T>>({ data: undefined, dataKey: undefined, error: null, updatedAt: null });
  const fetcherRef = useRef(fetcher);
  // Kept current by an effect declared before the polling effect, so a poll always calls the latest fetcher.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const run = useCallback(
    (force: boolean): Promise<void> => {
      if (inFlight.current && !force) return inFlight.current;
      const mine = ++generation.current;
      const promise = (async () => {
        try {
          const data = await fetcherRef.current();
          if (mine !== generation.current) return;
          setState({ data, dataKey: key, error: null, updatedAt: Date.now() });
        } catch (error) {
          if (mine !== generation.current) return;
          setState((current) => ({ ...current, error: error instanceof Error ? error : new Error(String(error)) }));
        } finally {
          if (mine === generation.current) inFlight.current = null;
        }
      })();
      inFlight.current = promise;
      return promise;
    },
    [key],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    void run(true);
    const timer = setInterval(() => void run(false), intervalMs);
    return () => {
      clearInterval(timer);
      // Whatever is still in flight belongs to a run that no longer exists.
      generation.current += 1;
      inFlight.current = null;
    };
  }, [enabled, intervalMs, run]);

  const refresh = useCallback(() => (enabled ? run(true) : Promise.resolve()), [enabled, run]);

  const mine = state.dataKey === key;
  return { data: mine ? state.data : undefined, error: state.error, loading: !mine || state.updatedAt === null, updatedAt: mine ? state.updatedAt : null, refresh };
}

/** Whether the browser tab is in front. A hidden tab (another tab, a locked phone) stops polling. */
export function usePageVisible(): boolean {
  const read = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const [visible, setVisible] = useState(read);
  useEffect(() => {
    const onChange = () => setVisible(read());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

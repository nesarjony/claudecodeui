import { useCallback, useEffect, useRef, useState } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { registerResource } from '@/modules/foreman-next/hooks/refreshClock';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';

export type Resource<T> = {
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  error: Error | null;
  refresh: () => Promise<void>;
};

type Loaded<T> = { key: string; status: 'ready' | 'error'; data: T | null; error: Error | null };

type Options<T> = { key?: string; keepPolling?: (data: T) => boolean };

/**
 * Used by every route, the shell, the chat drawer and the modals to load one slice of Foreman's state; panels, cards and
 * rows receive it. All resources refresh together on one clock and after every action (see refreshClock). `key` reloads
 * it when its subject changes (a goal id), `keepPolling` ends the polling once the data says nothing more will change.
 * A failed refresh keeps the last data, so a screen never blanks out because one poll failed.
 */
export function useForemanResource<T>(load: (api: ForemanApi) => Promise<T>, { key = '', keepPolling }: Options<T> = {}): Resource<T> {
  const api = useForemanApi();
  // The caller passes new closures each render; refresh and the clock always use the latest ones.
  const loadRef = useRef(load);
  const keepPollingRef = useRef(keepPolling);
  // The newest request wins, so a slow answer for an old key can never overwrite the current one.
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  // Data, error and the key they belong to change together; a different key reads as loading without a reset effect.
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const loadedRef = useRef(loaded);

  useEffect(() => {
    loadRef.current = load;
    keepPollingRef.current = keepPolling;
    loadedRef.current = loaded;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    try {
      const data = await loadRef.current(api);
      if (mounted.current && request === latestRequest.current) setLoaded({ key, status: 'ready', data, error: null });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (mounted.current && request === latestRequest.current) {
        setLoaded((previous) => ({ key, status: 'error', data: previous?.key === key ? previous.data : null, error }));
      }
    }
  }, [api, key]);

  useEffect(() => {
    void refresh();
    return registerResource({
      refresh: () => void refresh(),
      polls: () => {
        const data = loadedRef.current?.data ?? null;
        return data === null || keepPollingRef.current === undefined || keepPollingRef.current(data);
      },
    });
  }, [refresh]);

  if (!loaded || loaded.key !== key) return { status: 'loading', data: null, error: null, refresh };
  return { status: loaded.status, data: loaded.data, error: loaded.error, refresh };
}

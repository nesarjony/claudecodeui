import { useCallback, useEffect, useRef, useState } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';

export type Resource<T> = {
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  error: Error | null;
  refresh: () => Promise<void>;
};

type Loaded<T> = { key: string; status: 'ready' | 'error'; data: T | null; error: Error | null };

type Options = { pollMs?: number; key?: string };

/**
 * Used by every screen and panel of the module to load one slice of Foreman's state. `key` reloads it when its subject
 * changes (a goal id), `pollMs` keeps it current. A failed refresh keeps the last data, so a screen never blanks out
 * because one poll failed.
 */
export function useForemanResource<T>(load: (api: ForemanApi) => Promise<T>, { pollMs, key = '' }: Options = {}): Resource<T> {
  const api = useForemanApi();
  // The caller passes a new closure each render; refresh always runs the latest one.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  // The newest request wins, so a slow answer for an old key can never overwrite the current one.
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Data, error and the key they belong to change together; a different key reads as loading without a reset effect.
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);

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
    if (!pollMs) return undefined;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  if (!loaded || loaded.key !== key) return { status: 'loading', data: null, error: null, refresh };
  return { status: loaded.status, data: loaded.data, error: loaded.error, refresh };
}

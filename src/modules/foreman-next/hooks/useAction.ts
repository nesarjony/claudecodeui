import { useCallback, useState } from 'react';

import { refreshAll } from '@/modules/foreman-next/hooks/refreshClock';

type ActionState = { busy: boolean; failed: boolean };

export type Outcome<T> = { ok: true; value: T } | { ok: false };

/**
 * Used by every control that changes Foreman's state: it disables the control while the request runs, says when it
 * failed, hands back what the request returned, and refreshes everything on screen after a success.
 */
export function useAction(): { busy: boolean; failed: boolean; run: <T>(task: () => Promise<T>) => Promise<Outcome<T>> } {
  // Whether a request is in flight and whether the last one failed: the controls disable and show the error from it.
  const [state, setState] = useState<ActionState>({ busy: false, failed: false });
  const run = useCallback(async <T>(task: () => Promise<T>): Promise<Outcome<T>> => {
    setState({ busy: true, failed: false });
    try {
      const value = await task();
      setState({ busy: false, failed: false });
      refreshAll();
      return { ok: true, value };
    } catch {
      setState({ busy: false, failed: true });
      return { ok: false };
    }
  }, []);
  return { ...state, run };
}

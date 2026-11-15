import { useCallback, useState } from 'react';

import { refreshAll } from '@/modules/foreman-next/hooks/refreshClock';

type ActionState = { busy: boolean; failed: boolean; message: string | null };

export type Outcome<T> = { ok: true; value: T } | { ok: false };

/**
 * Used by every control that changes Foreman's state: it disables the control while the request runs, says when it
 * failed (and why, when the refusal has words), hands back what the request returned, and refreshes everything on screen after a success.
 */
export function useAction(): { busy: boolean; failed: boolean; message: string | null; run: <T>(task: () => Promise<T>) => Promise<Outcome<T>> } {
  // Whether a request is in flight and whether the last one failed: the controls disable and show the error from it.
  const [state, setState] = useState<ActionState>({ busy: false, failed: false, message: null });
  const run = useCallback(async <T>(task: () => Promise<T>): Promise<Outcome<T>> => {
    setState({ busy: true, failed: false, message: null });
    try {
      const value = await task();
      setState({ busy: false, failed: false, message: null });
      refreshAll();
      return { ok: true, value };
    } catch (error) {
      // What Foreman said, when it said why: a refusal of a form is read to be acted on.
      setState({ busy: false, failed: true, message: error instanceof Error ? error.message : null });
      return { ok: false };
    }
  }, []);
  return { ...state, run };
}

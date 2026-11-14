import { useCallback, useState } from 'react';

type ActionState = { busy: boolean; failed: boolean };

/** Used by every button that changes Foreman's state, to disable itself while the request runs and to say when it failed. */
export function useAction(): { busy: boolean; failed: boolean; run: (task: () => Promise<unknown>) => Promise<boolean> } {
  // Whether a request is in flight and whether the last one failed: the controls disable and show the error from it.
  const [state, setState] = useState<ActionState>({ busy: false, failed: false });
  const run = useCallback(async (task: () => Promise<unknown>) => {
    setState({ busy: true, failed: false });
    try {
      await task();
      setState({ busy: false, failed: false });
      return true;
    } catch {
      setState({ busy: false, failed: true });
      return false;
    }
  }, []);
  return { ...state, run };
}

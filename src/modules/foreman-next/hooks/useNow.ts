import { useEffect, useState } from 'react';

/** Used by the veto countdowns and the relative times to re-render as time passes. */
export function useNow(intervalMs: number): number {
  // The clock: "in 3h" must change while nothing else on the screen does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

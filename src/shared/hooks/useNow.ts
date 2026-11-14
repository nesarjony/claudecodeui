import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, so "3 min. ago" and veto countdowns stay right without a render calling Date.now(). Used by the foreman and foreman-next modules. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

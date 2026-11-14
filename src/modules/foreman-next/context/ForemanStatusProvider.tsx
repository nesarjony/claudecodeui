import type { ReactNode } from 'react';

import { ForemanStatusContext } from '@/modules/foreman-next/context/foremanStatusContext';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';

const STATUS_POLL_MS = 10_000;

/** Used by ForemanShell so the status strip, the navigation and the connection banner share one polled status. */
export function ForemanStatusProvider({ children }: { children: ReactNode }) {
  const status = useForemanResource((api) => api.status(), { pollMs: STATUS_POLL_MS });
  return <ForemanStatusContext.Provider value={status}>{children}</ForemanStatusContext.Provider>;
}

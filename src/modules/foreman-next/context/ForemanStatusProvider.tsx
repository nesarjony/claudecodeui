import type { ReactNode } from 'react';

import { ForemanStatusContext } from '@/modules/foreman-next/context/foremanStatusContext';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by ForemanShell so the status strip, the navigation and the connection banner share one polled status. */
export function ForemanStatusProvider({ children }: { children: ReactNode }) {
  const status = useForemanResource((api) => api.status());
  return <ForemanStatusContext.Provider value={status}>{children}</ForemanStatusContext.Provider>;
}

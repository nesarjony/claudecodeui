import type { ReactNode } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { ForemanApiContext } from '@/modules/foreman-next/context/foremanApiContext';

/** Used by ForemanNextRoutes and the lazy entries to give every screen the API; tests pass their own. */
export function ForemanApiProvider({ api, children }: { api: ForemanApi; children: ReactNode }) {
  return <ForemanApiContext.Provider value={api}>{children}</ForemanApiContext.Provider>;
}

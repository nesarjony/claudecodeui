import type { ReactNode } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { getForemanApi } from '@/modules/foreman-next/api/createForemanApi';
import { ForemanApiContext } from '@/modules/foreman-next/context/foremanApiContext';

type ForemanApiProviderProps = { api?: ForemanApi; children: ReactNode };

/** Used by ForemanNextRoutes and the session bar to give every screen the chosen API; tests pass their own. */
export function ForemanApiProvider({ api, children }: ForemanApiProviderProps) {
  return <ForemanApiContext.Provider value={api ?? getForemanApi()}>{children}</ForemanApiContext.Provider>;
}

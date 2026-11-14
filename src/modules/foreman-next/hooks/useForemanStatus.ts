import { useContext } from 'react';

import type { ForemanStatus } from '@/modules/foreman-next/api/contract';
import { ForemanStatusContext } from '@/modules/foreman-next/context/foremanStatusContext';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by the status strip, the navigation and the connection banner to read the polled status. */
export function useForemanStatus(): Resource<ForemanStatus> {
  const status = useContext(ForemanStatusContext);
  if (!status) throw new Error('useForemanStatus needs the ForemanShell');
  return status;
}

const NOTHING = (): Promise<void> => Promise.resolve();

/** Used by the actions that change a count in the status strip (answer, veto, pause) to refresh it at once instead of at the next poll. */
export function useRefreshStatus(): () => Promise<void> {
  return useContext(ForemanStatusContext)?.refresh ?? NOTHING;
}

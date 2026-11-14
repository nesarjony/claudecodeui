import { useContext } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { ForemanApiContext } from '@/modules/foreman-next/context/foremanApiContext';

/** Used by every hook and component of the module that talks to Foreman; it only ever sees the contract. */
export function useForemanApi(): ForemanApi {
  const api = useContext(ForemanApiContext);
  if (!api) throw new Error('useForemanApi needs a ForemanApiProvider');
  return api;
}

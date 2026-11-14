import { createContext } from 'react';

import type { ForemanStatus } from '@/modules/foreman-next/api/contract';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by ForemanStatusProvider and the status hooks; null outside the shell, where nothing shows the status. */
export const ForemanStatusContext = createContext<Resource<ForemanStatus> | null>(null);

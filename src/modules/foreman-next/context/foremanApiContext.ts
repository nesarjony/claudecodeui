import { createContext } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';

/** Used by ForemanApiProvider and useForemanApi; screens read the API through the hook, never from here. */
export const ForemanApiContext = createContext<ForemanApi | null>(null);

import { loadForemanApi } from '@/modules/foreman-next/api/loadForemanApi';

/** Used by the three lazy entries: one API instance for the whole app, so the mock keeps its state between the Foreman screens, the session view and the sidebar. */
export const foremanApi = await loadForemanApi();

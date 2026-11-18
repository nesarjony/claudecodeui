/**
 * The Foreman tab is the old Foreman's. A build made for the rebuilt one (`VITE_FOREMAN_NEXT_API=real`, which is what the cutover builds) has the new
 * screens instead, and the old tab would only fail against it, so that build has no tab. Read when asked, not when the module loads, so a test can set it.
 */
export const isForemanTabAvailable = (): boolean => import.meta.env.VITE_FOREMAN_NEXT_API !== 'real';

/**
 * The "Foreman suggests" card and its Quick Settings switch are the old Foreman's too: the rebuilt one makes no suggestions, and the server answers none once `FOREMAN_URL` names it.
 * The build made for the rebuilt Foreman therefore does not ask for them or offer the switch.
 */
export const areForemanSuggestionsAvailable = (): boolean => isForemanTabAvailable();

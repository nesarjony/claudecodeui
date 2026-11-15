/**
 * The Foreman tab is the old Foreman's. A build made for the rebuilt one (`VITE_FOREMAN_NEXT_API=real`, which is what the cutover builds) has the new
 * screens instead, and the old tab would only fail against it, so that build has no tab. Read when asked, not when the module loads, so a test can set it.
 */
export const isForemanTabAvailable = (): boolean => import.meta.env.VITE_FOREMAN_NEXT_API !== 'real';

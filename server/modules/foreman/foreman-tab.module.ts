import { resolveBridgeTokenFile } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanTabRouter } from '@/modules/foreman/foreman-tab.routes.js';
import { createForemanTabClient } from '@/modules/foreman/foreman-tab.service.js';

/**
 * The tab belongs to the old Foreman. `FOREMAN_URL` names the rebuilt one (the cutover sets it), and the tab's calls would then carry the bridge token
 * to a Foreman that refuses it, so the tab has no routes at all: the client's tab is hidden by the build that has the new screens
 * (`VITE_FOREMAN_NEXT_API=real`). Not deleted: unsetting `FOREMAN_URL` brings the tab back for the old Foreman.
 */
export const oldForemanTabEnabled = (environment: NodeJS.ProcessEnv = process.env): boolean => !environment.FOREMAN_URL?.trim();

/**
 * The Foreman tab's server half: the allowlisted, user-login-protected proxy to Foreman's `/foreman/*` routes.
 * Mounted at `/api/foreman-tab` behind `authenticateToken`; the bridge token is read from the same file as the bridge
 * and never leaves the server. Null when the tab is retired (`oldForemanTabEnabled`): there is then nothing to mount.
 */
// Consumed by the server entrypoint, which mounts the returned router.
export function createForemanTabModule(environment: NodeJS.ProcessEnv = process.env) {
  if (!oldForemanTabEnabled(environment)) return null;
  return createForemanTabRouter({
    client: createForemanTabClient({ tokenFile: resolveBridgeTokenFile(environment) }),
  });
}

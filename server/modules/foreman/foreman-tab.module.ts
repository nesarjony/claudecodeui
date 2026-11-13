import { resolveBridgeTokenFile } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanTabRouter } from '@/modules/foreman/foreman-tab.routes.js';
import { createForemanTabClient } from '@/modules/foreman/foreman-tab.service.js';

/**
 * The Foreman tab's server half: the allowlisted, user-login-protected proxy to Foreman's `/foreman/*` routes.
 * Mounted at `/api/foreman-tab` behind `authenticateToken`; the bridge token is read from the same file as the bridge
 * and never leaves the server.
 */
// Consumed by the server entrypoint, which mounts the returned router.
export function createForemanTabModule() {
  return createForemanTabRouter({
    client: createForemanTabClient({ tokenFile: resolveBridgeTokenFile() }),
  });
}

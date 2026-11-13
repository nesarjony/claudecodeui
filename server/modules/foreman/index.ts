// createForemanModule: used by the server entrypoint to mount the token-protected Foreman bridge
// (/api/foreman) and start pushing Claude session events to the Foreman service.
// createForemanUiModule: used by the server entrypoint to mount the user-login-protected suggestion routes
// (/api/foreman-suggestions) behind the "Foreman suggests" card.
export { createForemanModule, createForemanUiModule } from './foreman.module.js';

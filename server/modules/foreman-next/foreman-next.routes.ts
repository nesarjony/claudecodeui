export type ForemanNextRoute = {
  method: 'GET' | 'POST' | 'PUT';
  /** The Express path under `/api/foreman-next`; also Foreman's path under its `/foreman` prefix, which is why nothing else of Foreman is reachable. */
  path: string;
  /** The only query parameters forwarded; everything else is dropped. */
  query?: readonly string[];
  /** Routes that take a body forward the JSON as it came; Foreman checks it against its own schemas. */
  body: boolean;
};

/**
 * The slice-4a contract's endpoints, one line each (`src/modules/foreman-next/api/contract/endpoints.ts`), and the whole of what the browser may ask of
 * Foreman: the proxy holds Foreman's API token, which opens far more, so the allowlist is the boundary. `/service-log` is not here: cloudcli serves it.
 */
export const FOREMAN_NEXT_ROUTES: readonly ForemanNextRoute[] = [
  { method: 'GET', path: '/status', body: false },
  { method: 'POST', path: '/status/pause', body: false },
  { method: 'POST', path: '/status/resume', body: false },
  { method: 'POST', path: '/status/stop', body: false },
  { method: 'GET', path: '/alerts', body: false },
  { method: 'GET', path: '/today', body: false },
  { method: 'GET', path: '/decide/questions', body: false },
  { method: 'POST', path: '/decide/questions/:id/answer', body: true },
  { method: 'GET', path: '/decide/review', body: false },
  { method: 'POST', path: '/decide/review/:id/veto', body: true },
  { method: 'POST', path: '/decide/review/:id/ok', body: false },
  { method: 'GET', path: '/decide/history', body: false },
  { method: 'GET', path: '/decisions/:id', body: false },
  { method: 'POST', path: '/decisions/:id/feedback', body: true },
  { method: 'GET', path: '/repos', body: false },
  { method: 'GET', path: '/work/goals', body: false },
  { method: 'GET', path: '/work/goals/:id', body: false },
  { method: 'POST', path: '/work/goals', body: true },
  { method: 'POST', path: '/work/goals/:id/strategy/approve', body: false },
  { method: 'POST', path: '/work/goals/:id/strategy/adjust', body: true },
  { method: 'POST', path: '/work/goals/:id/pause', body: false },
  { method: 'POST', path: '/work/goals/:id/resume', body: false },
  { method: 'POST', path: '/work/goals/:id/replan', body: false },
  { method: 'GET', path: '/work/runs/:id', body: false },
  { method: 'POST', path: '/work/runs/:id/pause', body: false },
  { method: 'POST', path: '/work/runs/:id/resume', body: false },
  { method: 'POST', path: '/work/runs/:id/stop', body: false },
  { method: 'POST', path: '/work/runs/:id/take-over', body: false },
  { method: 'POST', path: '/work/runs/:id/hand-back', body: false },
  { method: 'POST', path: '/work/runs/:id/replay/:step', body: false },
  { method: 'GET', path: '/chat/thread', query: ['kind', 'id'], body: false },
  { method: 'POST', path: '/chat/messages', body: true },
  { method: 'POST', path: '/chat/actions/:id/undo', body: false },
  { method: 'POST', path: '/chat/messages/:id/remember', body: false },
  { method: 'GET', path: '/sessions/:id/supervision', body: false },
  { method: 'POST', path: '/sessions/:id/hand-over', body: true },
  { method: 'POST', path: '/sessions/:id/take-back', body: false },
  { method: 'GET', path: '/settings/delegation', body: false },
  { method: 'PUT', path: '/settings/delegation/:kind', body: true },
  { method: 'GET', path: '/settings/attention', body: false },
  { method: 'PUT', path: '/settings/attention', body: true },
  { method: 'GET', path: '/settings', body: false },
];

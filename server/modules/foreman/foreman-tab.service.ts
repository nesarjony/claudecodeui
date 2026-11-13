import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import { resolveForemanBaseUrl } from '@/modules/foreman/foreman-suggestions.service.js';
import { AppError } from '@/shared/utils.js';

const FOREMAN_TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 100_000;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const STATUS_PATTERN = /^[a-z_]{1,32}$/;
const REPO_PATTERN = /^[A-Za-z0-9._ -]{1,80}$/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

type QueryRule = (value: string) => boolean;
type BodyRule = (body: unknown) => string | null;

/** One entry of the allowlist: a route the Foreman tab may call, and exactly what may be forwarded for it. */
export type ForemanTabRoute = {
  method: 'GET' | 'POST' | 'PUT';
  /** The Express path under `/api/foreman-tab`. */
  path: string;
  /** Foreman's route for the validated path parameters. */
  target: (params: Record<string, string>) => string;
  /** The only query parameters forwarded, each with its validator. Everything else is dropped. */
  query?: Record<string, QueryRule>;
  /** `null`: the route takes no body, and none is forwarded. Otherwise returns an error message for a bad body. */
  body: BodyRule | null;
  timeoutMs?: number;
};

const positiveInt = (max: number): QueryRule => (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max;
const oneOf = (...values: string[]): QueryRule => (value) => values.includes(value);

const configBody: BodyRule = (body) => {
  const record = asRecord(body);
  if (!record) return 'The body must be a JSON object with the settings to change.';
  return JSON.stringify(record).length > MAX_BODY_CHARS ? 'The body is too large.' : null;
};

const answerBody: BodyRule = (body) => {
  const record = asRecord(body);
  if (!record) return 'The body must be a JSON object.';
  const { text, allow, reason } = record;
  if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 20_000)) return 'text must be a non-empty string of at most 20000 characters.';
  if (allow !== undefined && typeof allow !== 'boolean') return 'allow must be true or false.';
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 2000)) return 'reason must be a string of at most 2000 characters.';
  if (text === undefined && allow === undefined) return 'Send text, or allow true or false.';
  return null;
};

/**
 * Everything the Foreman tab may ask of Foreman. This table is the allowlist: a path that is not here is a 404 and
 * never reaches Foreman, a query parameter that is not listed is dropped, and a body is checked before it is forwarded.
 * The bridge token is added by the client below, server-side. Foreman's other routes (`/foreman/events`,
 * `/foreman/decide`, `/foreman/evals/run`, `/foreman/suggestions`) are deliberately absent.
 */
// Consumed by the router builder (foreman-tab.routes.ts) and asserted route by route in the tests.
export const FOREMAN_TAB_ROUTES: readonly ForemanTabRoute[] = [
  { method: 'GET', path: '/overview', target: () => '/foreman/ui/overview', body: null },
  {
    method: 'GET',
    path: '/decisions',
    target: () => '/foreman/decisions',
    query: { limit: positiveInt(200), sessionId: (v) => SESSION_ID_PATTERN.test(v) },
    body: null,
  },
  { method: 'GET', path: '/spend', target: () => '/foreman/spend', query: { range: oneOf('today', '7d', '30d') }, body: null },
  { method: 'GET', path: '/agreement', target: () => '/foreman/agreement', query: { range: oneOf('today', '7d', '30d', 'all') }, body: null },
  { method: 'GET', path: '/config', target: () => '/foreman/config', body: null },
  { method: 'PUT', path: '/config', target: () => '/foreman/config', body: configBody, timeoutMs: 10_000 },
  { method: 'GET', path: '/studio-link', target: () => '/foreman/ui/studio-link', query: { traceId: (v) => TRACE_ID_PATTERN.test(v) }, body: null },
  { method: 'GET', path: '/tasks', target: () => '/foreman/tasks', query: { status: (v) => STATUS_PATTERN.test(v) }, body: null },
  { method: 'GET', path: '/tasks/:id', target: ({ id }) => `/foreman/tasks/${encodeURIComponent(id!)}`, body: null },
  { method: 'POST', path: '/tasks/:id/takeover', target: ({ id }) => `/foreman/tasks/${encodeURIComponent(id!)}/takeover`, body: null },
  { method: 'POST', path: '/kill', target: () => '/foreman/kill', body: null },
  { method: 'POST', path: '/resume', target: () => '/foreman/resume', body: null },
  { method: 'GET', path: '/inbox', target: () => '/foreman/inbox', body: null },
  { method: 'POST', path: '/inbox/:id/answer', target: ({ id }) => `/foreman/inbox/${encodeURIComponent(id!)}/answer`, body: answerBody },
  { method: 'GET', path: '/lessons', target: () => '/foreman/lessons', query: { repo: (v) => REPO_PATTERN.test(v) }, body: null },
  { method: 'POST', path: '/lessons/:id/retire', target: ({ id }) => `/foreman/lessons/${encodeURIComponent(id!)}/retire`, body: null },
];

type ForemanTabClientDependencies = {
  tokenFile: string;
  /** Foreman's origin. Defaults like the suggestions client: `FOREMAN_URL`, then `FOREMAN_EVENTS_URL`'s origin, then local. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** What the client needs to know about a request, already matched to a route of the allowlist. */
export type ForemanTabRequest = {
  route: ForemanTabRoute;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
};

/**
 * Checks the path parameters, the query and the body of a request against its allowlist entry. Returns the query
 * string to forward (only listed, valid parameters) or throws a 400.
 */
// Consumed by the client below and by the tests.
export function validateForemanTabRequest(request: ForemanTabRequest): string {
  for (const [name, value] of Object.entries(request.params)) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      throw invalid(`Invalid ${name}.`);
    }
  }
  const forwarded = new URLSearchParams();
  for (const [name, rule] of Object.entries(request.route.query ?? {})) {
    const raw = request.query[name];
    if (raw === undefined || raw === '') {
      continue;
    }
    if (typeof raw !== 'string' || !rule(raw)) {
      throw invalid(`Invalid ${name}.`);
    }
    forwarded.set(name, raw);
  }
  if (request.route.body) {
    const problem = request.route.body(request.body);
    if (problem) {
      throw invalid(problem);
    }
  }
  const serialized = forwarded.toString();
  return serialized ? `?${serialized}` : '';
}

/**
 * cloudcli's calls to Foreman for the Foreman tab, on behalf of the signed-in user. The route must come from
 * `FOREMAN_TAB_ROUTES`; the bridge token is added here and never reaches the browser.
 */
// Consumed by the router in foreman-tab.routes.ts.
export function createForemanTabClient(dependencies: ForemanTabClientDependencies) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return {
    /** Forwards one validated request and returns Foreman's JSON answer, or throws the cloudcli error that fits. */
    async forward(request: ForemanTabRequest): Promise<unknown> {
      const search = validateForemanTabRequest(request);
      const token = await readBridgeToken(dependencies.tokenFile);
      if (!token) {
        throw new AppError('The Foreman bridge is disabled: no bridge token is configured.', {
          code: 'FOREMAN_BRIDGE_DISABLED',
          statusCode: 503,
        });
      }
      const hasBody = request.route.body !== null;
      let response: Response;
      try {
        response = await fetchImpl(`${resolveForemanBaseUrl(dependencies.baseUrl)}${request.route.target(request.params)}${search}`, {
          method: request.route.method,
          headers: { authorization: `Bearer ${token}`, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
          body: hasBody ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(request.route.timeoutMs ?? dependencies.timeoutMs ?? FOREMAN_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AppError(`Foreman is not reachable: ${error instanceof Error ? error.message : String(error)}`, {
          code: 'FOREMAN_UNAVAILABLE',
          statusCode: 502,
        });
      }
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (response.status === 200) {
        if (json === null) {
          throw new AppError('Foreman answered with something that is not JSON.', { code: 'FOREMAN_ERROR', statusCode: 502 });
        }
        return json;
      }
      const record = asRecord(json);
      const message = typeof record?.error === 'string' ? record.error : 'Foreman could not do that.';
      const details = record ? { fieldErrors: record.fieldErrors, issues: record.issues } : undefined;
      if (response.status === 400) {
        throw new AppError(message, { code: 'FOREMAN_REJECTED', statusCode: 400, details });
      }
      if (response.status === 404) {
        throw new AppError(message, { code: 'NOT_FOUND', statusCode: 404 });
      }
      if (response.status === 409) {
        throw new AppError(message, { code: 'CONFLICT', statusCode: 409 });
      }
      throw new AppError(message, { code: 'FOREMAN_ERROR', statusCode: 502 });
    },
  };
}

export type ForemanTabClient = ReturnType<typeof createForemanTabClient>;

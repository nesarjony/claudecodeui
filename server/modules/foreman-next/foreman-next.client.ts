import type { ForemanNextRoute } from '@/modules/foreman-next/foreman-next.routes.js';
import { AppError } from '@/shared/utils.js';

const FOREMAN_TIMEOUT_MS = 30_000;
/** What a path parameter may be: Foreman's ids hold letters, digits and `. _ : -`, and a decision's key can be long. */
const PARAM_PATTERN = /^[A-Za-z0-9._:-]{1,300}$/;
const MAX_BODY_CHARS = 100_000;

export interface ForemanNextConfig {
  /** Foreman's own origin: it stays on loopback, and this is the only thing that reaches it. */
  baseUrl: string;
  /** The server-to-server token, `FOREMAN_API_TOKEN` of Foreman's `workers.env`. It never leaves this process. */
  token: string | undefined;
}

export interface ForemanNextClient {
  forward(request: { route: ForemanNextRoute; params: Record<string, string>; query: Record<string, unknown>; body: unknown }): Promise<unknown>;
}

const asMessage = (value: unknown): { code: string; message: string } | undefined => {
  const error = value !== null && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== 'object') return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
};

/** Foreman's path for a route: its own prefix, then the contract's path with the parameters filled in, each checked first. */
export function targetOf(route: ForemanNextRoute, params: Record<string, string>): string {
  return `/foreman${route.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name] ?? '';
    if (!PARAM_PATTERN.test(value)) throw new AppError(`${name} is not a valid id.`, { code: 'INVALID_REQUEST', statusCode: 400 });
    return encodeURIComponent(value);
  })}`;
}

/**
 * The proxy's one way to Foreman: the contract's path under Foreman's `/foreman` prefix, with the API token, a timeout and nothing else.
 * An answer from Foreman is passed on as it is (cloudcli adds the envelope); a refusal keeps Foreman's code and message; Foreman not answering
 * is a 502 that says so, which the UI shows as "Foreman isn't responding".
 */
export function createForemanNextClient(config: ForemanNextConfig, fetchFn: typeof fetch = fetch): ForemanNextClient {
  return {
    async forward({ route, params, query, body }) {
      if (config.token === undefined) throw new AppError('Foreman is not configured: there is no API token.', { code: 'FOREMAN_NOT_CONFIGURED', statusCode: 503 });
      const url = new URL(targetOf(route, params), config.baseUrl);
      for (const name of route.query ?? []) {
        const value = query[name];
        if (typeof value === 'string') url.searchParams.set(name, value);
      }
      const text = route.body ? JSON.stringify(body ?? {}) : undefined;
      if (text !== undefined && text.length > MAX_BODY_CHARS) throw new AppError('The body is too large.', { code: 'INVALID_REQUEST', statusCode: 400 });
      let response: Response;
      try {
        response = await fetchFn(url, { method: route.method, headers: { authorization: `Bearer ${config.token}`, ...(text === undefined ? {} : { 'content-type': 'application/json' }) }, body: text, signal: AbortSignal.timeout(FOREMAN_TIMEOUT_MS) });
      } catch (error) {
        throw new AppError(`Foreman did not answer: ${error instanceof Error ? error.message : String(error)}`, { code: 'FOREMAN_UNREACHABLE', statusCode: 502 });
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (response.ok) return payload ?? null;
      const refusal = asMessage(payload);
      throw new AppError(refusal?.message ?? `Foreman answered ${response.status}.`, { code: refusal?.code ?? 'FOREMAN_ERROR', statusCode: response.status >= 400 && response.status < 600 ? response.status : 502 });
    },
  };
}

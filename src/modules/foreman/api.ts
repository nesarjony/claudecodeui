import { authenticatedFetch, readApiJson } from '@/shared/api';
import type {
  AgreementRange,
  AgreementReport,
  ConfigResponse,
  DecisionItem,
  FieldErrors,
  InboxAnswer,
  InboxItem,
  Lesson,
  Overview,
  SpendRange,
  SpendReport,
  StudioLink,
  TaskDetail,
  TaskSummary,
} from '@/modules/foreman/types';

const BASE = '/api/foreman-tab';

type Query = Record<string, string | number | undefined | null>;

const withQuery = (path: string, query: Query = {}): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return `${BASE}${path}${text ? `?${text}` : ''}`;
};

async function request<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await readApiJson<{ success: true; data: T }>(response);
  return payload.data;
}

const enc = encodeURIComponent;

/**
 * The Foreman tab's calls. Each goes to cloudcli's allowlisted `/api/foreman-tab/*` proxy, which adds the bridge token
 * server-side. A failure throws an `ApiRequestError` (`code`, `status`, and for a refused settings change
 * `details.fieldErrors`).
 */
export const foremanTabApi = {
  overview: () => request<Overview>('GET', withQuery('/overview')),
  decisions: (options: { limit?: number; sessionId?: string } = {}) => request<DecisionItem[]>('GET', withQuery('/decisions', options)),
  spend: (range: SpendRange) => request<SpendReport>('GET', withQuery('/spend', { range })),
  agreement: (range: AgreementRange) => request<AgreementReport>('GET', withQuery('/agreement', { range })),
  getConfig: () => request<ConfigResponse>('GET', withQuery('/config')),
  /** A partial config: objects merge, arrays and scalars replace. */
  putConfig: (patch: Record<string, unknown>) => request<ConfigResponse>('PUT', withQuery('/config'), patch),
  studioLink: (traceId: string) => request<StudioLink>('GET', withQuery('/studio-link', { traceId })),
  tasks: (status?: string) => request<TaskSummary[]>('GET', withQuery('/tasks', { status })),
  task: (id: string) => request<TaskDetail>('GET', withQuery(`/tasks/${enc(id)}`)),
  takeover: (id: string) => request<unknown>('POST', withQuery(`/tasks/${enc(id)}/takeover`)),
  kill: () => request<{ killed: boolean }>('POST', withQuery('/kill')),
  resume: () => request<{ killed: boolean }>('POST', withQuery('/resume')),
  inbox: () => request<InboxItem[]>('GET', withQuery('/inbox')),
  answer: (id: string, answer: InboxAnswer) => request<unknown>('POST', withQuery(`/inbox/${enc(id)}/answer`), answer),
  lessons: (repo?: string) => request<Lesson[]>('GET', withQuery('/lessons', { repo })),
  retireLesson: (id: string) => request<unknown>('POST', withQuery(`/lessons/${enc(id)}/retire`)),
};

/** The per-field messages of a refused settings change, or null when the error is something else. */
export function fieldErrorsOf(error: unknown): FieldErrors | null {
  const details = (error as { details?: { fieldErrors?: unknown } } | null)?.details;
  const raw = details?.fieldErrors;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: FieldErrors = {};
  for (const [path, message] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof message === 'string') out[path] = message;
  }
  return Object.keys(out).length ? out : null;
}

/** Readable text for a failed call. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

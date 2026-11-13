import { authenticatedFetch, readApiJson } from '@/shared/api';
import type { ApprovePlanInput, CreateGoalInput, GoalDetail, GoalListItem, GoalStatus } from '@/modules/foreman/goals/types';

const BASE = '/api/foreman-tab/goals';

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await readApiJson<{ success: true; data: T }>(response);
  return payload.data;
}

const goalUrl = (id: string, action = ''): string => `${BASE}/${encodeURIComponent(id)}${action}`;

/**
 * The goal calls of the Foreman tab. Like the rest of the tab they go to cloudcli's allowlisted `/api/foreman-tab/*`
 * proxy, which checks them and adds the bridge token server-side. A failure throws an `ApiRequestError` (`code`,
 * `status`, and for a goal Foreman refused `details.issues`).
 */
export const goalsApi = {
  /** Newest first. `statuses` narrows the list (`?status=running,paused`). */
  list: (statuses?: GoalStatus[]) => request<GoalListItem[]>('GET', statuses && statuses.length > 0 ? `${BASE}?status=${encodeURIComponent(statuses.join(','))}` : BASE),
  get: (id: string) => request<GoalDetail>('GET', goalUrl(id)),
  create: (input: CreateGoalInput) => request<GoalListItem>('POST', BASE, input),
  approvePlan: (id: string, input: ApprovePlanInput) => request<GoalDetail>('POST', goalUrl(id, '/approve-plan'), input),
  pause: (id: string) => request<GoalDetail>('POST', goalUrl(id, '/pause')),
  resume: (id: string) => request<GoalDetail>('POST', goalUrl(id, '/resume')),
  cancel: (id: string, reason?: string) => request<GoalDetail>('POST', goalUrl(id, '/cancel'), reason ? { reason } : {}),
};

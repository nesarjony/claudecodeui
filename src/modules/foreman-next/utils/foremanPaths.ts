import type { EntityRef } from '@/modules/foreman-next/api/contract';

const ROOT = '/foreman';

/** Used by every link and navigation in the module, so the URL layout of the Foreman section lives in one file. */
export const foremanPath = {
  today: ROOT,
  decide: `${ROOT}/decide`,
  needsYou: (questionId?: string) => `${ROOT}/decide/needs${questionId ? `/${questionId}` : ''}`,
  review: `${ROOT}/decide/review`,
  history: `${ROOT}/decide/history`,
  decision: (id: string) => `${ROOT}/decisions/${id}`,
  work: `${ROOT}/work`,
  goal: (id: string) => `${ROOT}/work/${id}`,
  goalCompare: (id: string) => `${ROOT}/work/${id}?compare=previous`,
  run: (id: string) => `${ROOT}/work/runs/${id}`,
  settings: `${ROOT}/settings`,
  alerts: `${ROOT}/alerts`,
  session: (id: string) => `/session/${id}`,
};

/** Where a link to a goal, a run or a decision opens: chat evidence, alerts and the like. */
export function entityPath(entity: EntityRef): string {
  if (entity.kind === 'run') return foremanPath.run(entity.id);
  if (entity.kind === 'decision') return foremanPath.decision(entity.id);
  return foremanPath.goal(entity.id);
}

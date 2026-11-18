import type { EntityRef } from '@/modules/foreman-next/api/contract';

const ROOT = '/foreman';

/** Used by every link and navigation in the module, so the URL layout of the Foreman section lives in one file. */
export const foremanPath = {
  today: ROOT,
  decide: `${ROOT}/decide`,
  needsYou: (questionId?: string) => `${ROOT}/decide/needs${questionId ? `/${questionId}` : ''}`,
  review: `${ROOT}/decide/review`,
  reviewItem: (id: string) => `${ROOT}/decide/review?item=${encodeURIComponent(id)}`,
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

/**
 * Where a link to a goal, a run or a decision opens: chat evidence, alerts and the like. A goal opens the goal page and a run the run page: the two have different ids, so a goal's
 * id on the run page is a 404. A kind this build does not know has no page, so it is `null` and nothing links to a guess.
 */
export function entityPath(entity: EntityRef): string | null {
  switch (entity.kind) {
    case 'goal':
      return foremanPath.goal(entity.id);
    case 'run':
      return foremanPath.run(entity.id);
    case 'decision':
      return foremanPath.decision(entity.id);
    default:
      return null;
  }
}

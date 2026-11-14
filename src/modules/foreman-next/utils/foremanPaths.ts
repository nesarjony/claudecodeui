import type { ChatLink } from '@/modules/foreman-next/api/contract';

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
  run: (id: string) => `${ROOT}/work/runs/${id}`,
  settings: `${ROOT}/settings`,
};

/** Where an evidence link in a chat answer opens. */
export function chatLinkPath(link: ChatLink): string {
  if (link.kind === 'run') return foremanPath.run(link.id);
  if (link.kind === 'decision') return foremanPath.decision(link.id);
  return foremanPath.goal(link.id);
}

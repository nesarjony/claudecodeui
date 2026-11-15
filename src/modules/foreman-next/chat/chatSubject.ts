import { matchPath } from 'react-router-dom';

import type { ChatSubjectRef } from '@/modules/foreman-next/api/contract';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

const GENERAL: ChatSubjectRef = { kind: 'general', id: null };

/** What the drawer is about when it opens: the goal, run or decision on screen, else Foreman in general (wireframes §8). */
export function subjectFromPath(pathname: string): ChatSubjectRef {
  const run = matchPath(foremanPath.run(':id'), pathname)?.params.id;
  if (run) return { kind: 'run', id: run };
  const decision = matchPath(foremanPath.decision(':id'), pathname)?.params.id;
  if (decision) return { kind: 'decision', id: decision };
  const goal = matchPath(foremanPath.goal(':id'), pathname)?.params.id;
  if (goal) return { kind: 'goal', id: goal };
  return GENERAL;
}

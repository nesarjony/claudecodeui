import { matchPath } from 'react-router-dom';

import type { ChatSubjectRef, ForemanApi } from '@/modules/foreman-next/api/contract';
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

export type ChatContext = { goalId: string | null; label: string | null };

/** The goal whose conversation holds a subject (history is kept per goal), and a name for the subject, as Foreman knows them. */
export async function chatContextOf(api: ForemanApi, subject: ChatSubjectRef): Promise<ChatContext> {
  if (subject.id === null) return { goalId: null, label: null };
  if (subject.kind === 'goal') return { goalId: subject.id, label: (await api.goal(subject.id)).title };
  if (subject.kind === 'run') {
    const run = await api.run(subject.id);
    return { goalId: run.goalId, label: run.batch };
  }
  const decision = await api.decision(subject.id);
  return { goalId: decision.goalId, label: decision.title };
}

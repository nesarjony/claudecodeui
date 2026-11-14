import { ApiRequestError } from '@/shared/api';
import type { ChatSubjectRef, GoalDetail, RunDetail, RunSummary } from '@/modules/foreman-next/api/contract';
import { at } from '@/modules/foreman-next/api/mock/time';

export const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export const notFound = (what: string): ApiRequestError => new ApiRequestError(`${what} not found`, { code: 'not_found', status: 404 });

export const isLiveHandOver = (run: RunDetail): boolean => run.kind === 'handed-over' && (run.state === 'running' || run.state === 'paused');

export function summaryOf(run: RunDetail): RunSummary {
  const current = run.stages.find((stage) => stage.state === 'running' || stage.state === 'failed') ?? run.stages[run.stages.length - 1];
  return {
    id: run.id,
    kind: run.kind,
    batch: run.batch,
    stage: current?.id ?? 'worker',
    turn: run.turn,
    rows: null,
    elapsedMinutes: run.elapsedMinutes,
    turnsWithoutCommit: null,
  };
}

export const threadKey = (subject: ChatSubjectRef): string => `${subject.kind}:${subject.id ?? ''}`;

export function find<T extends { id: string }>(items: T[], id: string, what: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw notFound(what);
  return found;
}

export function newGoalDetail(request: { repo: string; goal: string }, id: string, now: number): GoalDetail {
  const name = request.goal.trim();
  return {
    id,
    repo: request.repo,
    name,
    title: `${request.repo} · ${name}`,
    doneWhen: 'every checklist row is DONE and verified by the judge',
    state: 'queued',
    done: 0,
    total: 60,
    counts: { done: 0, built: 0, todo: 60 },
    forecast: null,
    waitsOnYou: { decisions: 0, rowsHeld: 0 },
    batch: null,
    queuedAfter: null,
    hasStrategy: true,
    spentUsd: 0,
    daysTaken: null,
    spent: { usd: 0, shareUsd: 25, firstPassYield: 0, usdPerRow: 0 },
    strategy: {
      version: 1,
      replannedAt: at(now, 0),
      reason: 'first plan, from the repo study',
      status: 'awaiting-approval',
      steps: ['Contract batch first', 'Layout, then components', 'Integration and the judge pass last'],
      risks: ['no donor tests for part of the checklist'],
      previous: null,
    },
    batches: [],
  };
}

export function newHandedOverRun(sessionId: string, goal: string | null, id: string): RunDetail {
  return {
    id,
    kind: 'handed-over',
    goalId: null,
    goal,
    batch: `Session ${sessionId}`,
    model: 'Opus',
    sandboxed: false,
    turn: 0,
    elapsedMinutes: 0,
    minimaxWindowPct: 0,
    state: 'running',
    stages: [
      { id: 'attach', state: 'running' },
      { id: 'worker', state: 'pending' },
      { id: 'checks', state: 'pending' },
      { id: 'judge', state: 'pending' },
      { id: 'close', state: 'pending' },
    ],
    nextCheck: 'when the session says done, asks something, or goes 10 turns without a commit',
    control: 'foreman',
    sessionId,
    failure: null,
    decisions: [],
    worker: null,
    verdict: null,
  };
}

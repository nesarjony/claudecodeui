import { ApiRequestError } from '@/shared/api';
import type { ForecastTrend, GoalBudget, GoalDetail, RunDetail, RunSummary, StrategyStudy, StudyStep } from '@/modules/foreman-next/api/contract';
import { STUDY_STEP_IDS } from '@/modules/foreman-next/api/contract';
import { at } from '@/modules/foreman-next/api/mock/time';

/** What a goal with no limit and nothing forecast yet says of its budget, and of how its forecast fared: nothing to compare. */
export const NO_BUDGET: GoalBudget = { limitUsd: null, deadline: null, projectedUsd: null, fits: null, onTime: null };
export const NO_FORECAST_TREND: ForecastTrend = { points: [], cumulativeUsdErrorPct: null, cumulativeWorkerWindowsErrorPct: null };
/** A study that had the code graph, so the plan was made with it. */
export const STUDY_WITH_CODE_GRAPH: StrategyStudy = { structure: 'infigraph', reason: null };

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

export function find<T extends { id: string }>(items: T[], id: string, what: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw notFound(what);
  return found;
}

/** How far through its study a goal is: the steps before the current one are done, the current one runs, the rest wait. */
export function studySteps(progress: number): StudyStep[] {
  const reached = Math.min(STUDY_STEP_IDS.length, Math.floor(progress * STUDY_STEP_IDS.length));
  return STUDY_STEP_IDS.map((id, position) => ({ id, state: position < reached ? 'done' : position === reached ? 'running' : 'pending' }));
}

export function newGoalDetail(request: { repo: string; goal: string }, id: string): GoalDetail {
  const name = request.goal.trim();
  return {
    id,
    repo: request.repo,
    name,
    title: `${request.repo} · ${name}`,
    doneWhen: 'every checklist row is DONE and verified by the judge',
    budget: NO_BUDGET,
    forecastTrend: NO_FORECAST_TREND,
    state: 'studying',
    done: 0,
    total: 60,
    counts: { done: 0, built: 0, todo: 60 },
    forecast: null,
    waitsOnYou: { decisions: 0, rowsHeld: 0 },
    batch: null,
    queuedAfter: null,
    hasStrategy: false,
    readOnly: null,
    spentUsd: 0,
    daysTaken: null,
    spent: { usd: 0, shareUsd: 25, firstPassYield: 0, usdPerRow: 0 },
    study: studySteps(0),
    strategy: null,
    batches: [],
    repoProgress: [],
  };
}

/** What Foreman proposes once it has studied a new goal; it waits for the owner's approval before any worker starts. */
export function firstStrategy(now: number): NonNullable<GoalDetail['strategy']> {
  return {
    version: 1,
    replannedAt: at(now, 0),
    reason: 'first plan, from the repo study',
    status: 'awaiting-approval',
    study: STUDY_WITH_CODE_GRAPH,
    steps: ['Contract batch first', 'Layout, then components', 'Integration and the judge pass last'],
    risks: ['no donor tests for part of the checklist'],
    previous: null,
    changes: null,
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

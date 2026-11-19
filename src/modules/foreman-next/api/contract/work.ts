import type { LedgerChoice, IsoTime, Maker } from '@/modules/foreman-next/api/contract/foundation';

export const GOAL_STATES = ['studying', 'active', 'queued', 'paused', 'read-only', 'done'] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const FORECAST_CERTAINTIES = ['likely', 'uncertain'] as const;
export type Forecast = { batchesLeft: number; usdToGo: number; minimaxWindows: number; doneBy: IsoTime | null; certainty: (typeof FORECAST_CERTAINTIES)[number] };

// A handed-over run (BR-2.10) starts with `attach` instead of `brief`: Foreman attaches to the owner's session rather than preparing a worker.
export const RUN_STAGE_IDS = ['attach', 'brief', 'worker', 'checks', 'judge', 'close'] as const;
export type RunStageId = (typeof RUN_STAGE_IDS)[number];
export const RUN_STAGE_STATES = ['done', 'running', 'pending', 'failed'] as const;
export type RunStageState = (typeof RUN_STAGE_STATES)[number];
export type RunStage = { id: RunStageId; state: RunStageState };
export type RunKind = 'worker' | 'handed-over';

export type RunSummary = {
  id: string;
  kind: RunKind;
  // The batch name, or the session's title for a handed-over run.
  batch: string;
  stage: RunStageId;
  turn: number | null;
  rows: number | null;
  elapsedMinutes: number;
  turnsWithoutCommit: number | null;
};

/**
 * A goal planned on a read-only repo (desk) waits for the owner's switch for that repo in Settings → Repos, and nothing runs on it: its rows are
 * done when his own pipeline judges them, and the repo says so (`RepoProgressPoint`). `repo` is the name the repo is registered under.
 */
export type ReadOnlyWait = { repo: string };

export type GoalSummary = {
  id: string;
  repo: string;
  name: string;
  state: GoalState;
  done: number;
  total: number;
  forecast: Forecast | null;
  waitsOnYou: { decisions: number; rowsHeld: number };
  batch: { current: number; total: number } | null;
  queuedAfter: string | null;
  hasStrategy: boolean;
  readOnly: ReadOnlyWait | null;
  spentUsd: number;
  daysTaken: number | null;
};
export type GoalsOverview = { programme: string | null; goals: GoalSummary[]; handedOver: RunSummary[] };
/**
 * A goal in the owner's words (BR-1.1). `successMeasure` is how he will know it is done, in the repo's own units; `budgetUsd` is the most it may cost Foreman in API credit, and a goal that
 * reaches it pauses; `deadline` is when he wants it done by. All three are optional (or null): `{ repo, goal }` is a goal measured by the repo's own check, with only the Charter's limits on it.
 */
/** The owner changes what he limited a goal to, after it started: a field left out is as it was, null takes the limit away. Raising a budget a goal has reached lets it go on. */
export type GoalLimitsChange = { budgetUsd?: number | null; deadline?: IsoTime | null };
export type NewGoalRequest = { repo: string; goal: string; successMeasure?: string | null; budgetUsd?: number | null; deadline?: IsoTime | null };

// What Foreman reads before it plans (wireframes §14): shown while a goal is `studying`.
export const STUDY_STEP_IDS = ['docs', 'conventions', 'checklist', 'git', 'code-map'] as const;
export type StudyStepId = (typeof STUDY_STEP_IDS)[number];
export const STUDY_STEP_STATES = ['done', 'running', 'pending'] as const;
export type StudyStep = { id: StudyStepId; state: (typeof STUDY_STEP_STATES)[number] };

export type StrategyStatus = 'awaiting-approval' | 'approved' | 'in-review';
/** Whether the study had the code graph (BR-5.12): `degraded` says why it had none, and the plan was made from file paths from git (BR-10.10). */
export type StrategyStudy = { structure: 'infigraph' | 'degraded'; reason: string | null };
/** What this version did to the one before it (BR-1.5): steps are named by their titles. Work already integrated is not counted as dropped. */
export type StrategyChanges = { againstVersion: number; added: string[]; removed: string[]; reordered: string[]; changed: string[]; risksAdded: string[]; risksRemoved: string[] };
export type Strategy = {
  version: number;
  replannedAt: IsoTime;
  reason: string;
  status: StrategyStatus;
  study: StrategyStudy;
  steps: string[];
  risks: string[];
  previous: { version: number; steps: string[] } | null;
  /** The difference from `previous`, null for a first version. */
  changes: StrategyChanges | null;
};

export const BATCH_STATES = ['done', 'running', 'waiting', 'queued'] as const;
export type BatchState = (typeof BATCH_STATES)[number];
export type BatchEntry = {
  index: number;
  name: string;
  rows: number;
  state: BatchState;
  turn: number | null;
  costUsd: number | null;
  firstPass: { passed: number; of: number } | null;
  waitsOn: { questionId: string; title: string } | null;
  runId: string | null;
};
/** What a repo says of a goal's rows when it was read at one of its commits: how many of the plan's rows it judges done. */
export type RepoProgressPoint = { repoHead: string; rowsDone: number; rowsBuilt: number; rowsPlanned: number; complete: boolean; recordedAt: IsoTime };
/** What the owner limited the goal to, and whether the forecast fits it: `fits` is whether what it has cost plus the forecast stays within `limitUsd`, `onTime` whether the forecast finishes by `deadline`. Null where there is no limit, or no forecast to compare. */
export type GoalBudget = { limitUsd: number | null; deadline: IsoTime | null; projectedUsd: number | null; fits: boolean | null; onTime: boolean | null };
/** One integrated batch against its forecast (BR-1.10): `errorPct` is signed, positive when it cost more than forecast. The worker's share is null where the allowance could not tell what one run used. */
export type ForecastErrorPoint = { batch: string; recordedAt: IsoTime; forecastUsd: number; actualUsd: number; errorPct: number | null; forecastWorkerWindows: number; actualWorkerWindows: number | null };
/** The forecast error after each batch, oldest first, and of the totals so far: null where nothing could be compared. Nothing here is estimated. */
export type ForecastTrend = { points: ForecastErrorPoint[]; cumulativeUsdErrorPct: number | null; cumulativeWorkerWindowsErrorPct: number | null };
export type GoalDetail = GoalSummary & {
  title: string;
  doneWhen: string;
  budget: GoalBudget;
  forecastTrend: ForecastTrend;
  counts: { done: number; built: number; todo: number };
  spent: { usd: number; shareUsd: number; firstPassYield: number; usdPerRow: number };
  study: StudyStep[] | null;
  strategy: Strategy | null;
  batches: BatchEntry[];
  /** Oldest first; empty until the repo has been read for the goal. */
  repoProgress: RepoProgressPoint[];
};

/** What the owner's stop of an experiment did (BR-6.4), at whatever stage it was: no batch is given the candidate from `stoppedAt`, and the experiment ends without a verdict. */
export type ExperimentStop = { id: string; goalId: string; stoppedAt: IsoTime };

export const RUN_FAILURE_NEXT = ['retry', 'replan', 'ask-owner'] as const;
export type RunFailure = { stage: RunStageId; reason: string; next: (typeof RUN_FAILURE_NEXT)[number] };
export type RunDecision = {
  id: string;
  turn: number;
  choice: LedgerChoice;
  maker: Maker;
  model: string | null;
  costUsd: number | null;
  quote: string | null;
  cardId: string | null;
};
export type WorkerSnapshot = { now: string; changed: { files: number; added: number; removed: number }; tools: string[]; says: string };
/** A deterministic gate of the quality bar that was run on the run's last commit, and what it found: the tests were not weakened, the licence rules held, no row accepted before was broken. Said in the owner's words, each finding with what to do about it. */
export type RunGate = { gate: 'tests' | 'licence' | 'regression'; passed: boolean; findings: string[] };
export type RunVerdict = {
  /** `output` is what the check printed, secrets scrubbed and the end of it when it was long: what the rows were accepted on. Null when the check was not run. `outputUrl` is not used. */
  check: { command: string; exitCode: number; cleanCopy: boolean; outputUrl: string | null; output: string | null };
  /** The gates run on the last commit, in the order tests, licence, regression; one that was not run for the repo is not listed. */
  gates: RunGate[];
  rows: { row: number; passed: boolean; note: string | null }[];
  verdictUrl: string | null;
  next: string | null;
};
export type RunDetail = {
  id: string;
  kind: RunKind;
  goalId: string | null;
  goal: string | null;
  batch: string;
  model: string;
  sandboxed: boolean;
  turn: number;
  elapsedMinutes: number;
  minimaxWindowPct: number;
  state: 'running' | 'paused' | 'stopped' | 'done';
  stages: RunStage[];
  nextCheck: string;
  control: 'foreman' | 'owner';
  sessionId: string | null;
  failure: RunFailure | null;
  decisions: RunDecision[];
  worker: WorkerSnapshot | null;
  verdict: RunVerdict | null;
};

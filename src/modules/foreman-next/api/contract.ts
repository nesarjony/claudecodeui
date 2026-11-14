export type IsoTime = string;

// Mirrors `decisionKindSchema` and `ledgerChoiceSchema` in foreman-next `src/ledger/kinds.ts` (branch slice/2-spine); the UI cannot import Foreman's code.
export type DecisionKind =
  | 'routine-turn'
  | 'worker-question'
  | 'worker-done'
  | 'worker-progress'
  | 'worker-error'
  | 'worker-refusal'
  | 'silent-session'
  | 'session-resync'
  | 'rework'
  | 'judge'
  | 'integrate'
  | 'guardrail'
  | 'pause'
  | 'alert'
  | 'owner-question'
  | 'takeover'
  | 'handback';

export type LedgerChoice =
  | 'continue'
  | 'steer'
  | 'answer'
  | 'ask_owner'
  | 'stop'
  | 'fresh_session'
  | 'pass'
  | 'fail'
  | 'integrated'
  | 'conflict'
  | 'blocked'
  | 'pause'
  | 'pause_batch'
  | 'take_over'
  | 'hand_back'
  | 'answered';

export type Maker = { type: 'code' } | { type: 'owner' } | { type: 'role'; role: 'supervisor' | 'judge'; version: number };

// The trust ladder (wireframes §11) delegates owner-facing categories, which are coarser than the ledger's kinds.
export type DelegationKind = 'product-scope' | 'replan-goal' | 'retry-batch' | 'budget-share' | 'worker-setup' | 'charter';
export type DelegationLevel = 'ask' | 'recommend-wait' | 'decide-tell' | 'decide-silent';

export type DegradedMode = 'api-credit' | 'minimax' | 'cloudcli' | 'postgres' | 'infigraph' | 'owner-away';
export type DegradedState = { mode: DegradedMode; since: IsoTime };

export type ForemanStatus = {
  state: 'running' | 'paused' | 'workers-paused' | 'stopped';
  pauseReason: 'owner' | 'api-ceiling' | 'minimax-window' | null;
  resumesAt: IsoTime | null;
  spend: { monthUsd: number; ceilingUsd: number; paceUsdPerDay: number };
  minimax: { fiveHourPct: number; weeklyPct: number };
  alerts: number;
  blockingDecisions: number;
  degraded: DegradedState[];
  studioUrl: string | null;
};

export type Briefing = { generatedAt: IsoTime; sentences: string[] };
export type TrendId = 'first-pass-yield' | 'usd-per-row' | 'agreed' | 'false-stops';
export type TrendMetric = { id: TrendId; previous: number | null; current: number; of: number | null };
// A handed-over run (BR-2.10) starts with `attach` instead of `brief`: Foreman attaches to the owner's session rather than preparing a worker.
export type RunStageId = 'attach' | 'brief' | 'worker' | 'checks' | 'judge' | 'close';
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
export type TodaySnapshot = { briefing: Briefing | null; trend: TrendMetric[]; running: RunSummary[] };

export type RememberScope = 'repo' | 'goal' | 'global';
export type QuestionOption = { id: string; label: string; rowsDelta: number; cost: string; risk: string };
export type SimilarDecision = { id: string; title: string; decidedAt: IsoTime; choice: string };
export type QuestionRecommendation = { optionId: string; confidence: number; reason: string; similar: SimilarDecision[] };
export type OwnerQuestion = {
  id: string;
  title: string;
  repo: string;
  goal: string;
  delegationKind: DelegationKind;
  delegationLevel: DelegationLevel;
  holdsRows: number;
  askedAt: IsoTime;
  context: string;
  options: QuestionOption[];
  recommendation: QuestionRecommendation | null;
  ifUnanswered: string;
};
export type QuestionAnswer = { optionId: string | null; reply: string | null; remember: RememberScope | null; delegate: boolean };

export type ReviewKind = 'rule' | 'lesson' | 'replan';
export type ReviewItem = { id: string; kind: ReviewKind; title: string; evidence: string; detail: string; closesAt: IsoTime };

export type HistoryEntry = {
  id: string;
  title: string;
  goal: string;
  decidedAt: IsoTime;
  decidedBy: 'owner' | 'foreman';
  choice: string;
  agreedWithRecommendation: boolean | null;
};

export type DecisionFeedback = { verdict: 'good' } | { verdict: 'bad'; correction: string | null };
export type DecisionRecord = {
  id: string;
  kind: DecisionKind;
  title: string;
  maker: Maker;
  model: string | null;
  costUsd: number;
  durationMs: number;
  traceUrl: string | null;
  saw: string;
  used: string[];
  considered: string[];
  chose: string;
  outcome: string | null;
  feedback: DecisionFeedback | null;
};

export type GoalState = 'active' | 'queued' | 'paused' | 'done';
export type Forecast = { batchesLeft: number; usdToGo: number; minimaxWindows: number; doneBy: IsoTime | null; certainty: 'likely' | 'uncertain' };
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
  spentUsd: number;
  daysTaken: number | null;
};
export type GoalsOverview = { programme: string | null; goals: GoalSummary[]; handedOver: RunSummary[] };
export type NewGoalRequest = { repo: string; goal: string };

export type StrategyStatus = 'awaiting-approval' | 'approved' | 'in-review';
export type Strategy = {
  version: number;
  replannedAt: IsoTime;
  reason: string;
  status: StrategyStatus;
  steps: string[];
  risks: string[];
  previous: { version: number; steps: string[] } | null;
};
export type BatchState = 'done' | 'running' | 'waiting' | 'queued';
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
export type GoalDetail = GoalSummary & {
  title: string;
  doneWhen: string;
  counts: { done: number; built: number; todo: number };
  spent: { usd: number; shareUsd: number; firstPassYield: number; usdPerRow: number };
  strategy: Strategy | null;
  batches: BatchEntry[];
};

export type RunStage = { id: RunStageId; state: 'done' | 'running' | 'pending' | 'failed' };
export type RunFailure = { stage: RunStageId; reason: string; next: 'retry' | 'replan' | 'ask-owner' };
export type RunDecision = {
  turn: number;
  choice: LedgerChoice;
  maker: Maker;
  model: string | null;
  costUsd: number | null;
  quote: string | null;
  cardId: string | null;
};
export type WorkerSnapshot = { now: string; changed: { files: number; added: number; removed: number }; tools: string[]; says: string };
export type RunVerdict = {
  check: { command: string; exitCode: number; cleanCopy: boolean; outputUrl: string | null };
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

export type SessionSupervision =
  | { state: 'unsupervised' }
  | { state: 'worker' }
  | { state: 'handed-over'; runId: string; goal: string | null; since: IsoTime };

export type ChatSubjectKind = 'general' | 'goal' | 'batch' | 'decision';
export type ChatSubjectRef = { kind: ChatSubjectKind; id: string | null };
export type ChatSubject = ChatSubjectRef & { label: string };
export type ChatDelivery = 'next-safe-point' | 'after-batch';
export type ChatLink = { label: string; kind: 'run' | 'decision' | 'goal'; id: string };
export type ChatActions = { id: string; count: number; undone: boolean };
export type ChatMessage = { id: string; role: 'owner' | 'foreman'; at: IsoTime; text: string; evidence: ChatLink[]; actions: ChatActions | null };
export type ChatThread = { subject: ChatSubject; subjects: ChatSubject[]; messages: ChatMessage[] };
export type ChatSendRequest = { subject: ChatSubjectRef; text: string; delivery: ChatDelivery };

export type DelegationRule = {
  kind: DelegationKind;
  level: DelegationLevel;
  vetoWindowHours: number | null;
  agreed: number;
  decided: number;
  suggestion: DelegationLevel | null;
  locked: boolean;
};
export type DelegationChange = { level: DelegationLevel; vetoWindowHours: number | null };

export type AttentionEvent = 'blocking-decision' | 'idle-decision' | 'pause' | 'stuck-work' | 'decided-alone' | 'progress' | 'routine';
export type AttentionRule = { event: AttentionEvent; phone: 'now' | 'delayed' | 'never'; phoneDelayMinutes: number | null; briefing: boolean };
export type AttentionPolicy = { rules: AttentionRule[]; quietFrom: string; quietTo: string; briefingAt: string };

export type ForemanApi = {
  status: () => Promise<ForemanStatus>;
  pauseAll: () => Promise<ForemanStatus>;
  resumeAll: () => Promise<ForemanStatus>;
  stopAll: () => Promise<ForemanStatus>;
  serviceLog: () => Promise<string[]>;
  today: () => Promise<TodaySnapshot>;
  questions: () => Promise<OwnerQuestion[]>;
  answerQuestion: (id: string, answer: QuestionAnswer) => Promise<void>;
  review: () => Promise<ReviewItem[]>;
  vetoReviewItem: (id: string, reason: string) => Promise<void>;
  acknowledgeReviewItem: (id: string) => Promise<void>;
  history: () => Promise<HistoryEntry[]>;
  decision: (id: string) => Promise<DecisionRecord>;
  rateDecision: (id: string, feedback: DecisionFeedback) => Promise<DecisionRecord>;
  goals: () => Promise<GoalsOverview>;
  goal: (id: string) => Promise<GoalDetail>;
  createGoal: (request: NewGoalRequest) => Promise<GoalSummary>;
  approveStrategy: (goalId: string) => Promise<GoalDetail>;
  adjustStrategy: (goalId: string, note: string) => Promise<GoalDetail>;
  pauseGoal: (goalId: string) => Promise<GoalDetail>;
  resumeGoal: (goalId: string) => Promise<GoalDetail>;
  replanGoal: (goalId: string) => Promise<GoalDetail>;
  run: (id: string) => Promise<RunDetail>;
  pauseRun: (id: string) => Promise<RunDetail>;
  resumeRun: (id: string) => Promise<RunDetail>;
  stopRun: (id: string) => Promise<RunDetail>;
  takeOverRun: (id: string) => Promise<RunDetail>;
  handBackRun: (id: string) => Promise<RunDetail>;
  replayRun: (id: string, fromStep: RunStageId) => Promise<RunDetail>;
  chatThread: (subject: ChatSubjectRef) => Promise<ChatThread>;
  sendChat: (request: ChatSendRequest) => Promise<ChatMessage[]>;
  undoChatActions: (actionsId: string) => Promise<ChatMessage>;
  sessionSupervision: (sessionId: string) => Promise<SessionSupervision>;
  handOverSession: (sessionId: string, goal?: string) => Promise<RunDetail>;
  takeBackSession: (sessionId: string) => Promise<RunDetail>;
  delegation: () => Promise<DelegationRule[]>;
  setDelegation: (kind: DelegationKind, change: DelegationChange) => Promise<DelegationRule>;
  attention: () => Promise<AttentionPolicy>;
  setAttention: (policy: AttentionPolicy) => Promise<AttentionPolicy>;
};

export type EndpointSpec = { method: 'GET' | 'POST' | 'PUT'; path: string };

// Paths are relative to the Foreman API base; `:id`, `:kind` and `:step` are path parameters. Every response is `{ success: true, data }`.
export const FOREMAN_NEXT_API_BASE = '/api/foreman-next';

export const ENDPOINTS = {
  status: { method: 'GET', path: '/status' },
  pauseAll: { method: 'POST', path: '/status/pause' },
  resumeAll: { method: 'POST', path: '/status/resume' },
  stopAll: { method: 'POST', path: '/status/stop' },
  serviceLog: { method: 'GET', path: '/service-log' },
  today: { method: 'GET', path: '/today' },
  questions: { method: 'GET', path: '/decide/questions' },
  answerQuestion: { method: 'POST', path: '/decide/questions/:id/answer' },
  review: { method: 'GET', path: '/decide/review' },
  vetoReviewItem: { method: 'POST', path: '/decide/review/:id/veto' },
  acknowledgeReviewItem: { method: 'POST', path: '/decide/review/:id/ok' },
  history: { method: 'GET', path: '/decide/history' },
  decision: { method: 'GET', path: '/decisions/:id' },
  rateDecision: { method: 'POST', path: '/decisions/:id/feedback' },
  goals: { method: 'GET', path: '/work/goals' },
  goal: { method: 'GET', path: '/work/goals/:id' },
  createGoal: { method: 'POST', path: '/work/goals' },
  approveStrategy: { method: 'POST', path: '/work/goals/:id/strategy/approve' },
  adjustStrategy: { method: 'POST', path: '/work/goals/:id/strategy/adjust' },
  pauseGoal: { method: 'POST', path: '/work/goals/:id/pause' },
  resumeGoal: { method: 'POST', path: '/work/goals/:id/resume' },
  replanGoal: { method: 'POST', path: '/work/goals/:id/replan' },
  run: { method: 'GET', path: '/work/runs/:id' },
  pauseRun: { method: 'POST', path: '/work/runs/:id/pause' },
  resumeRun: { method: 'POST', path: '/work/runs/:id/resume' },
  stopRun: { method: 'POST', path: '/work/runs/:id/stop' },
  takeOverRun: { method: 'POST', path: '/work/runs/:id/take-over' },
  handBackRun: { method: 'POST', path: '/work/runs/:id/hand-back' },
  replayRun: { method: 'POST', path: '/work/runs/:id/replay/:step' },
  chatThread: { method: 'GET', path: '/chat/thread' },
  sendChat: { method: 'POST', path: '/chat/messages' },
  undoChatActions: { method: 'POST', path: '/chat/actions/:id/undo' },
  sessionSupervision: { method: 'GET', path: '/sessions/:id/supervision' },
  handOverSession: { method: 'POST', path: '/sessions/:id/hand-over' },
  takeBackSession: { method: 'POST', path: '/sessions/:id/take-back' },
  delegation: { method: 'GET', path: '/settings/delegation' },
  setDelegation: { method: 'PUT', path: '/settings/delegation/:kind' },
  attention: { method: 'GET', path: '/settings/attention' },
  setAttention: { method: 'PUT', path: '/settings/attention' },
} as const satisfies Record<keyof ForemanApi, EndpointSpec>;

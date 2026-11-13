/** The shapes the Foreman tab reads, as Foreman's `/foreman/*` routes answer them (through cloudcli's `/api/foreman-tab`). */

export type ForemanMode = 'shadow' | 'autonomous';
export type ForemanRisk = 'low' | 'medium' | 'high';
export type SpendRange = 'today' | '7d' | '30d';
export type AgreementRange = 'today' | '7d' | '30d' | 'all';

export type AgreementBucket = {
  key: string;
  answered: number;
  sent: number;
  edited: number;
  dismissed: number;
  acceptanceRate: number;
  usedRate: number;
  meanValue: number;
};

export type AgreementReport = {
  range: AgreementRange;
  overall: AgreementBucket;
  byAction: AgreementBucket[];
  byPromptVersion: AgreementBucket[];
  byModel: AgreementBucket[];
  byEscalation: AgreementBucket[];
  statusCounts: Record<string, number>;
};

export type Overview = {
  mode: ForemanMode;
  killed: boolean;
  budgets: { today: { foremanUsd: number; workerUsd: number; limitUsd: number } };
  activeTasks: number;
  needsUserCount: number;
  agreement7d: AgreementBucket | null;
};

export type DecisionItem = {
  id: string;
  ts: string;
  sessionId: string;
  taskId: string | null;
  action: string;
  reason: string;
  confidence: number;
  risk: ForemanRisk;
  status: string;
  model: string;
  traceId: string | null;
  kind?: 'suggestion' | 'action';
  escalated?: boolean;
  detail?: string | null;
};

export type ForemanSpendRow = {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type WorkerSpendRow = {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  toolCalls: number;
  toolErrors: number;
};

export type SpendReport = {
  range: SpendRange;
  since: string;
  foreman: { byRole: ForemanSpendRow[]; byModel: ForemanSpendRow[]; total: number; calls: number };
  worker: { byModel: WorkerSpendRow[]; byTask: WorkerSpendRow[]; bySession: WorkerSpendRow[]; total: number; turns: number };
};

export type ModelAlias = 'api-opus' | 'api-sonnet' | 'api-haiku';
export type ForemanRole = 'planner' | 'strategist' | 'supervisor' | 'judge' | 'contextKeeper' | 'researcher';
export type Effort = 'low' | 'medium' | 'high';

export type RoleModelConfig = { model: ModelAlias; escalate: ModelAlias[]; effort: Effort; promptVersion: string };

/** The part of Foreman's config the settings form edits. Other keys travel along untouched. */
export type ForemanConfig = {
  mode: ForemanMode;
  repos: Array<{ name: string; path: string }>;
  maxConcurrentSessions: number;
  perRepo: number;
  budgets: { perTaskUsd: number; perDayUsd: number };
  autoAnswerConfidence: number;
  models: Record<ForemanRole, RoleModelConfig>;
  context: { notesAt: number; actAt: number };
  evals: { decisionQualityRate: number };
  escalation: { confidenceBelow: number; riskAtLeast: ForemanRisk; maxSteps: number };
  [key: string]: unknown;
};

export type ConfigOptions = {
  modelAliases: ModelAlias[];
  roles: ForemanRole[];
  efforts: Effort[];
  risks: ForemanRisk[];
  modes: ForemanMode[];
};

export type ConfigResponse = { config: ForemanConfig; options: ConfigOptions };

/** Milestone 5 owns the task shapes; the tab reads them defensively (every field but id may be missing). */
export type TaskSummary = {
  id: string;
  title?: string;
  repo?: string;
  status?: string;
  playbook?: string;
  sessionId?: string | null;
  costUsd?: number;
  startedAt?: string;
  updatedAt?: string;
  lastDecision?: string | { action?: string; reason?: string; summary?: string } | null;
};

export type TimelineKind = 'decision' | 'action' | 'gate' | 'judge' | 'needs_user' | 'note';
export type TimelineEntry = { ts: string; kind: TimelineKind | string; summary: string; traceId?: string | null };
export type TaskDetail = TaskSummary & { dod?: unknown; timeline?: TimelineEntry[] };

export type InboxKind = 'question' | 'permission' | 'budget';
export type InboxItem = {
  id: string;
  kind: InboxKind | string;
  taskId?: string | null;
  sessionId?: string | null;
  title?: string;
  question?: string;
  options?: string[];
  createdAt?: string;
};
export type InboxAnswer = { text?: string; allow?: boolean; reason?: string };

/** Milestone 8 owns lessons. */
export type Lesson = {
  id: string;
  repo?: string;
  text?: string;
  status?: string;
  confidence?: number;
  uses?: number;
  evidence?: unknown;
};

export type StudioLink = { traceId: string; url: string; tunnel: string; hint: string };

export type FieldErrors = Record<string, string>;

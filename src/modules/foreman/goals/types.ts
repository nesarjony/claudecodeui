/**
 * Goals and big work (Milestone 7), as Foreman's `/foreman/goals` routes answer them through cloudcli's
 * `/api/foreman-tab/goals` proxy. The contract is the section "Goals and big work (Milestone 7)" of Foreman's
 * docs/BRIDGE.md.
 */

export type GoalStatus = 'planning' | 'awaiting_approval' | 'running' | 'judging' | 'done' | 'failed' | 'paused' | 'cancelled';

export type GoalNextKind = 'plan_approval' | 'budget' | 'question' | 'task' | 'judge' | 'none';

/** What happens next or what the goal waits for. */
export type GoalNext = { kind: GoalNextKind; text: string; inboxId: string | null };

export type GoalPlaybook = 'P3' | 'P4' | 'P6';

export type GoalListItem = {
  /** `goal_<uuid>` */
  id: string;
  title: string;
  status: GoalStatus;
  repos: string[];
  budgetUsd: number;
  /** The goal's tasks (Foreman and worker) plus the planner and the judge. */
  spentUsd: number;
  tasksDone: number;
  /** 0 until a plan exists. */
  tasksTotal: number;
  playbook: GoalPlaybook | null;
  next: GoalNext;
  deadline: string | null;
  overdue: boolean;
  endReason: string | null;
  /** The goal's root trace. */
  traceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalMilestone = { key: string; title: string; goal: string; taskKeys: string[] };

export type GoalPlan = {
  rationale: string;
  estimatedCostUsd: number;
  /** 1 for the first plan; grows with each "revise". */
  revision: number;
  milestones: GoalMilestone[];
};

export type GoalTaskStatus = 'planned' | 'blocked' | 'ready' | 'running' | 'needs_user' | 'completed' | 'failed' | 'cancelled';
export type GoalTaskKind = 'implement' | 'analysis' | 'synthesis' | 'verify' | 'checkpoint' | 'fixup';

export type GoalTaskView = {
  /** The plan's key ("t3"), stable across the goal's life. */
  key: string;
  /** The queue task id once launched. */
  taskId: string | null;
  title: string;
  /** A milestone key; fix-up tasks use "fixups". */
  milestone: string;
  kind: GoalTaskKind;
  playbook: 'P1' | 'P2' | 'P4';
  repo: string;
  /** Task keys. */
  dependsOn: string[];
  status: GoalTaskStatus;
  dod: { goal: string; acceptanceCriteria: string[]; gateCommands: string[] };
  estimatedCostUsd: number;
  costUsd: number;
  /** The task's own trace. */
  traceId: string | null;
  /** The end summary once the task ended. */
  summary: string | null;
};

export type GoalVerdict = {
  run: number;
  passed: boolean;
  reasoning: string;
  unmet: string[];
  feedback: string;
  /** Tasks the verdict added. */
  fixupKeys: string[];
  model: string;
  costUsd: number;
  traceId: string | null;
  at: string;
};

export type GoalPendingKind = 'plan' | 'budget' | 'question';
export type GoalPending = { kind: GoalPendingKind; question: string; inboxId: string };

export type GoalSpend = { foremanUsd: number; workerUsd: number; goalUsd: number; totalUsd: number; budgetUsd: number };

export type GoalTimelineEntry = { ts: string; kind: string; summary: string; traceId: string | null };

export type GoalDetail = GoalListItem & {
  description: string;
  constraints: string | null;
  requirePlanApproval: boolean;
  /** The user's note when approving or revising the plan. */
  planNote: string | null;
  plan: GoalPlan | null;
  /** Dependency-ordered (a task comes after everything it depends on); fix-up tasks included. */
  tasks: GoalTaskView[];
  /** The goal judge's runs, oldest first. */
  verdicts: GoalVerdict[];
  judgeRuns: number;
  /** Most judge runs (raised by "continue" answers). */
  maxRuns: number;
  /** Failed parts re-planned so far. */
  replans: number;
  /** The 80% budget warning has fired. */
  warnedAt80: boolean;
  spend: GoalSpend;
  pending: GoalPending | null;
  timeline: GoalTimelineEntry[];
};

/** `POST /goals`. `repos` are names from the config's repos; the first is the goal's primary repo. */
export type CreateGoalInput = {
  title: string;
  description: string;
  repos: string[];
  constraints?: string;
  budgetUsd: number;
  /** An ISO date-time. Informational: shown, and a goal past it is flagged. */
  deadline?: string;
  requirePlanApproval?: boolean;
};

export type PlanDecision = 'approve' | 'revise' | 'reject';

/** `POST /goals/:id/approve-plan`. A revise needs a note. */
export type ApprovePlanInput = { decision: PlanDecision; note?: string };

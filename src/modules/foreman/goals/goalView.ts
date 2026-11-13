import type { ChipTone } from '@/modules/foreman/chipTone';
import type {
  CreateGoalInput,
  GoalDetail,
  GoalListItem,
  GoalNextKind,
  GoalStatus,
  GoalTaskView,
} from '@/modules/foreman/goals/types';

/** Statuses of a goal that is still going (or waiting on the user). Everything else has ended. */
export const ACTIVE_GOAL_STATUSES: readonly GoalStatus[] = ['planning', 'awaiting_approval', 'running', 'judging', 'paused'];
export const ENDED_GOAL_STATUSES: readonly GoalStatus[] = ['done', 'failed', 'cancelled'];

export const isActiveGoal = (goal: Pick<GoalListItem, 'status'>): boolean => ACTIVE_GOAL_STATUSES.includes(goal.status);

export const goalStatusTone = (status: string): ChipTone => {
  switch (status) {
    case 'planning':
    case 'running':
    case 'judging':
      return 'info';
    case 'awaiting_approval':
    case 'paused':
      return 'warn';
    case 'done':
      return 'good';
    case 'failed':
      return 'bad';
    default:
      return 'neutral';
  }
};

export const goalTaskStatusTone = (status: string): ChipTone => {
  switch (status) {
    case 'ready':
    case 'running':
      return 'info';
    case 'needs_user':
      return 'warn';
    case 'completed':
      return 'good';
    case 'failed':
      return 'bad';
    default:
      return 'neutral';
  }
};

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/** Tasks done of the plan's tasks. A goal without a plan yet is at 0 of 0 (and 0%). */
export function goalProgress(goal: Pick<GoalListItem, 'tasksDone' | 'tasksTotal'>): { done: number; total: number; percent: number } {
  const total = Math.max(0, Math.floor(finite(goal.tasksTotal)));
  const done = Math.min(total, Math.max(0, Math.floor(finite(goal.tasksDone))));
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** The share of the budget at which the goal is flagged (the coordinator warns at the same point). */
export const BUDGET_WARN_AT = 0.8;

/**
 * Spend against the budget: the fraction (not clamped, so 1.2 is 20% over), the bar width (clamped to 0 to 100) and
 * the tone: warn from 80%, bad at 100%.
 */
export function budgetUse(spentUsd: number, budgetUsd: number): { fraction: number; width: number; tone: ChipTone } {
  const spent = Math.max(0, finite(spentUsd));
  const budget = finite(budgetUsd);
  const fraction = budget > 0 ? spent / budget : spent > 0 ? 1 : 0;
  const tone: ChipTone = fraction >= 1 ? 'bad' : fraction >= BUDGET_WARN_AT ? 'warn' : 'neutral';
  return { fraction, width: Math.round(Math.min(1, fraction) * 100), tone };
}

/** Whether the goal is past its deadline: Foreman's flag, or a deadline that passed while the goal is still going. */
export function isOverdue(goal: Pick<GoalListItem, 'overdue' | 'deadline' | 'status'>, now: number): boolean {
  if (goal.overdue) return true;
  if (!goal.deadline || !isActiveGoal(goal)) return false;
  const at = Date.parse(goal.deadline);
  return !Number.isNaN(at) && at < now;
}

/**
 * The next item of a goal as one line: Foreman's own text, or the label for what it waits on (`label`, per kind).
 * Null when nothing is next.
 */
export function nextLine(next: GoalListItem['next'] | null | undefined, label: (kind: GoalNextKind) => string): string | null {
  if (!next) return null;
  const text = typeof next.text === 'string' ? next.text.trim() : '';
  if (text) return text;
  return next.kind === 'none' ? null : label(next.kind) || null;
}

export type GoalActions = {
  canApprove: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** Paused on a budget or a question: only an answer settles it, so Resume stays off. */
  resumeNeedsAnswer: boolean;
};

/** Which controls a goal allows in its status (Foreman answers 409 to the others). */
export function goalActions(goal: Pick<GoalDetail, 'status'> & { pending?: GoalDetail['pending'] }): GoalActions {
  const resumeNeedsAnswer = goal.status === 'paused' && !!goal.pending && goal.pending.kind !== 'plan';
  return {
    canApprove: goal.status === 'awaiting_approval',
    canPause: goal.status === 'running' || goal.status === 'judging',
    canResume: goal.status === 'paused' && !resumeNeedsAnswer,
    canCancel: !ENDED_GOAL_STATUSES.includes(goal.status),
    resumeNeedsAnswer,
  };
}

/**
 * The tasks in dependency order: a task comes after every task it depends on. Foreman already sends them that way;
 * this keeps the given order wherever it is valid, and never loses a task (a cycle or an unknown key leaves the rest in
 * their given order at the end).
 */
export function dependencyOrder(tasks: readonly GoalTaskView[]): GoalTaskView[] {
  const keys = new Set(tasks.map((task) => task.key));
  const placed = new Set<string>();
  const ordered: GoalTaskView[] = [];
  const rest = [...tasks];
  while (rest.length > 0) {
    const index = rest.findIndex((task) => task.dependsOn.every((key) => !keys.has(key) || placed.has(key) || key === task.key));
    if (index === -1) {
      ordered.push(...rest);
      break;
    }
    const [next] = rest.splice(index, 1);
    ordered.push(next!);
    placed.add(next!.key);
  }
  return ordered;
}

export const FIXUPS_MILESTONE = 'fixups';

export type MilestoneGroup = {
  key: string;
  /** Empty for a milestone the plan does not name (fix-ups): the caller labels it. */
  title: string;
  goal: string;
  tasks: GoalTaskView[];
  done: number;
};

/**
 * The plan's milestones in plan order, each with its tasks in dependency order, then any tasks whose milestone the plan
 * does not list (the judge's fix-ups) in groups of their own.
 */
export function groupByMilestone(goal: Pick<GoalDetail, 'plan' | 'tasks'>): MilestoneGroup[] {
  const ordered = dependencyOrder(goal.tasks);
  const milestones = goal.plan?.milestones ?? [];
  const named = new Set(milestones.map((milestone) => milestone.key));
  const groups: MilestoneGroup[] = milestones.map((milestone) => ({ key: milestone.key, title: milestone.title, goal: milestone.goal, tasks: [], done: 0 }));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const task of ordered) {
    let group = byKey.get(task.milestone);
    if (!group) {
      group = { key: task.milestone, title: '', goal: '', tasks: [], done: 0 };
      byKey.set(task.milestone, group);
      groups.push(group);
    }
    group.tasks.push(task);
    if (task.status === 'completed') group.done += 1;
  }
  // Unnamed groups keep their first-seen order but always come after the plan's milestones.
  return [...groups.filter((group) => named.has(group.key)), ...groups.filter((group) => !named.has(group.key))];
}

/** The titles of the tasks with these keys (the key itself when the task is not in the list). */
export function taskTitles(keys: readonly string[], tasks: readonly GoalTaskView[]): string[] {
  const titles = new Map(tasks.map((task) => [task.key, task.title]));
  return keys.map((key) => titles.get(key) ?? key);
}

/** The new-goal form as typed. */
export type GoalForm = {
  title: string;
  description: string;
  /** In the order they were ticked: the first is the goal's primary repo. */
  repos: string[];
  /** False until the user ticks or unticks a repo (until then a single configured repo counts as picked). */
  reposTouched: boolean;
  constraints: string;
  budget: string;
  /** A `datetime-local` value ("2026-12-01T17:00"), in the browser's time zone, or empty. */
  deadline: string;
  requirePlanApproval: boolean;
};

export const DEFAULT_GOAL_BUDGET_USD = 5;

export const EMPTY_GOAL_FORM: GoalForm = {
  title: '',
  description: '',
  repos: [],
  reposTouched: false,
  constraints: '',
  budget: String(DEFAULT_GOAL_BUDGET_USD),
  deadline: '',
  requirePlanApproval: true,
};

export const GOAL_LIMITS = { title: 200, description: 20_000, constraints: 5000, budgetMax: 1000 } as const;

export type GoalFormField = 'title' | 'description' | 'repos' | 'constraints' | 'budget' | 'deadline';
/** Field -> i18n key of the message. */
export type GoalFormErrors = Partial<Record<GoalFormField, string>>;

/** Dollars as typed: "5", "2.50", "$5". Null for anything else. */
export function parseUsd(text: string): number | null {
  const cleaned = text.trim().replace(/^\$\s*/, '');
  if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A `datetime-local` value as an ISO date-time (the browser's time zone), or null when it is empty or not a date. */
export function deadlineIso(local: string): string | null {
  if (!local.trim()) return null;
  const at = Date.parse(local);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** The form's problems, as i18n keys per field. Empty when the form can be sent. Mirrors Foreman's limits. */
export function validateGoalForm(form: GoalForm): GoalFormErrors {
  const errors: GoalFormErrors = {};
  const title = form.title.trim();
  if (!title) errors.title = 'goals.form.errors.titleRequired';
  else if (title.length > GOAL_LIMITS.title) errors.title = 'goals.form.errors.titleTooLong';
  const description = form.description.trim();
  if (!description) errors.description = 'goals.form.errors.descriptionRequired';
  else if (description.length > GOAL_LIMITS.description) errors.description = 'goals.form.errors.descriptionTooLong';
  if (form.repos.length === 0) errors.repos = 'goals.form.errors.reposRequired';
  if (form.constraints.trim().length > GOAL_LIMITS.constraints) errors.constraints = 'goals.form.errors.constraintsTooLong';
  const budget = parseUsd(form.budget);
  if (budget === null || budget <= 0 || budget > GOAL_LIMITS.budgetMax) errors.budget = 'goals.form.errors.budget';
  if (form.deadline.trim() && deadlineIso(form.deadline) === null) errors.deadline = 'goals.form.errors.deadline';
  return errors;
}

/** The body of `POST /goals` for a valid form: trimmed text, optional fields left out when empty. */
export function buildCreateGoalInput(form: GoalForm): CreateGoalInput {
  const constraints = form.constraints.trim();
  const deadline = deadlineIso(form.deadline);
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    repos: [...form.repos],
    budgetUsd: parseUsd(form.budget) ?? DEFAULT_GOAL_BUDGET_USD,
    ...(constraints ? { constraints } : {}),
    ...(deadline ? { deadline } : {}),
    requirePlanApproval: form.requirePlanApproval,
  };
}

/** Foreman's per-field problems with a refused goal (`error.details.issues`), as readable lines. */
export function issueLines(error: unknown): string[] {
  const issues = (error as { details?: { issues?: unknown } } | null)?.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (typeof issue === 'string') return issue.trim() ? [issue.trim()] : [];
    if (!issue || typeof issue !== 'object') return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string' || !message.trim()) return [];
    const where = Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : '';
    return [where ? `${where}: ${message}` : message];
  });
}

/** A deadline in the UI language ("1 Dec 2026, 17:00"). Empty for a missing or unparseable time. */
export function formatDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}

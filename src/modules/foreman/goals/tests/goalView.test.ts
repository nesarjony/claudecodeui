import { describe, expect, it } from 'vitest';

import enForeman from '@/modules/i18n/locales/en/foreman.json';
import {
  budgetUse,
  buildCreateGoalInput,
  deadlineIso,
  dependencyOrder,
  EMPTY_GOAL_FORM,
  formatDateTime,
  goalActions,
  goalProgress,
  goalStatusTone,
  goalTaskStatusTone,
  groupByMilestone,
  isActiveGoal,
  isOverdue,
  issueLines,
  nextLine,
  parseUsd,
  taskTitles,
  validateGoalForm,
  type GoalForm,
} from '@/modules/foreman/goals/goalView';
import type { GoalStatus, GoalTaskView } from '@/modules/foreman/goals/types';
import { GOALS, PAUSED_BY_USER, PAUSED_ON_BUDGET, PAUSED_ON_QUESTION, PLAN_DETAIL, RUNNING_DETAIL } from '@/modules/foreman/goals/tests/fixtures';

const ALL_STATUSES: GoalStatus[] = ['planning', 'awaiting_approval', 'running', 'judging', 'done', 'failed', 'paused', 'cancelled'];
const NOW = Date.parse('2026-11-13T10:00:00.000Z');

const has = (key: string): boolean => {
  let node: unknown = enForeman;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in (node as Record<string, unknown>))) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
};

describe('progress and budget', () => {
  it('counts tasks done, and a goal without a plan is at 0 of 0', () => {
    expect(goalProgress({ tasksDone: 2, tasksTotal: 5 })).toEqual({ done: 2, total: 5, percent: 40 });
    expect(goalProgress({ tasksDone: 0, tasksTotal: 0 })).toEqual({ done: 0, total: 0, percent: 0 });
    expect(goalProgress({ tasksDone: 9, tasksTotal: 3 })).toEqual({ done: 3, total: 3, percent: 100 });
    expect(goalProgress({ tasksDone: Number.NaN, tasksTotal: 4 })).toEqual({ done: 0, total: 4, percent: 0 });
  });

  it('warns from 80% of the budget and is bad at 100%, with the bar clamped', () => {
    expect(budgetUse(3.95, 5)).toMatchObject({ tone: 'neutral', width: 79 });
    expect(budgetUse(4, 5)).toMatchObject({ tone: 'warn', width: 80 });
    expect(budgetUse(4.99, 5).tone).toBe('warn');
    expect(budgetUse(5, 5)).toMatchObject({ tone: 'bad', width: 100 });
    expect(budgetUse(6, 5)).toMatchObject({ tone: 'bad', width: 100, fraction: 1.2 });
    expect(budgetUse(0, 0)).toMatchObject({ tone: 'neutral', width: 0 });
    expect(budgetUse(0.1, 0).tone).toBe('bad');
  });
});

describe('status', () => {
  it('gives every goal and task status a tone and tells active goals from ended ones', () => {
    expect(ALL_STATUSES.map(goalStatusTone)).toEqual(['info', 'warn', 'info', 'info', 'good', 'bad', 'warn', 'neutral']);
    expect(['planned', 'blocked', 'ready', 'running', 'needs_user', 'completed', 'failed', 'cancelled'].map(goalTaskStatusTone)).toEqual([
      'neutral', 'neutral', 'info', 'info', 'warn', 'good', 'bad', 'neutral',
    ]);
    expect(ALL_STATUSES.filter((status) => isActiveGoal({ status }))).toEqual(['planning', 'awaiting_approval', 'running', 'judging', 'paused']);
  });

  it('flags a goal past its deadline only while it is still going (or when Foreman says so)', () => {
    expect(isOverdue(GOALS[1]!, NOW)).toBe(true); // Foreman's flag
    expect(isOverdue({ status: 'running', overdue: false, deadline: '2026-11-13T09:00:00.000Z' }, NOW)).toBe(true);
    expect(isOverdue({ status: 'running', overdue: false, deadline: '2026-11-14T09:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'done', overdue: false, deadline: '2026-11-13T09:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'running', overdue: false, deadline: 'soon' }, NOW)).toBe(false);
  });

  it('enables pause, resume, cancel and approval per status, and keeps Resume off while an answer is owed', () => {
    const actions = (status: GoalStatus, pending: (typeof PLAN_DETAIL)['pending'] = null) => goalActions({ status, pending });
    expect(actions('awaiting_approval', PLAN_DETAIL.pending)).toEqual({ canApprove: true, canPause: false, canResume: false, canCancel: true, resumeNeedsAnswer: false });
    expect(actions('running')).toMatchObject({ canApprove: false, canPause: true, canResume: false, canCancel: true });
    expect(actions('judging')).toMatchObject({ canPause: true, canResume: false });
    expect(goalActions(PAUSED_BY_USER)).toMatchObject({ canPause: false, canResume: true, canCancel: true, resumeNeedsAnswer: false });
    expect(goalActions(PAUSED_ON_QUESTION)).toMatchObject({ canResume: false, resumeNeedsAnswer: true });
    expect(goalActions(PAUSED_ON_BUDGET)).toMatchObject({ canResume: false, resumeNeedsAnswer: true });
    for (const ended of ['done', 'failed', 'cancelled'] as const) {
      expect(actions(ended)).toEqual({ canApprove: false, canPause: false, canResume: false, canCancel: false, resumeNeedsAnswer: false });
    }
    expect(actions('planning')).toMatchObject({ canPause: false, canCancel: true });
  });

  it('says what comes next: Foreman\'s text, else a label per kind, else nothing', () => {
    const label = (kind: string) => `label:${kind}`;
    expect(nextLine(GOALS[1]!.next, label)).toBe('Write the migration for the tax table');
    expect(nextLine(GOALS[0]!.next, label)).toBe('label:plan_approval');
    expect(nextLine({ kind: 'none', text: '  ', inboxId: null }, label)).toBeNull();
    expect(nextLine(null, label)).toBeNull();
  });
});

describe('the plan', () => {
  const keys = (tasks: GoalTaskView[]) => tasks.map((task) => task.key);

  it('orders tasks after everything they depend on, keeping the given order where it is already valid', () => {
    expect(keys(dependencyOrder(PLAN_DETAIL.tasks))).toEqual(['t1', 't2', 't3', 't4']);
    expect(keys(dependencyOrder(RUNNING_DETAIL.tasks))).toEqual(['t1', 't2', 't3', 't4', 'f1']);
  });

  it('never loses a task to a cycle or an unknown dependency', () => {
    const cyclic = [
      { ...PLAN_DETAIL.tasks[0]!, key: 'a', dependsOn: ['b'] },
      { ...PLAN_DETAIL.tasks[0]!, key: 'b', dependsOn: ['a'] },
      { ...PLAN_DETAIL.tasks[0]!, key: 'c', dependsOn: ['missing'] },
    ];
    expect(keys(dependencyOrder(cyclic))).toEqual(['c', 'a', 'b']);
  });

  it('groups tasks by the plan\'s milestones in plan order, with fix-ups last', () => {
    const groups = groupByMilestone(RUNNING_DETAIL);
    expect(groups.map((group) => [group.key, group.title, keys(group.tasks), group.done])).toEqual([
      ['m1', 'Bump', ['t1', 't2'], 2],
      ['m2', 'Fix', ['t3', 't4'], 0],
      ['fixups', '', ['f1'], 0],
    ]);
    expect(groupByMilestone(PLAN_DETAIL).map((group) => keys(group.tasks))).toEqual([['t1'], ['t2', 't3', 't4']]);
  });

  it('keeps a milestone with no tasks, and copes with no plan at all', () => {
    const withEmpty = { ...PLAN_DETAIL, plan: { ...PLAN_DETAIL.plan!, milestones: [...PLAN_DETAIL.plan!.milestones, { key: 'm3', title: 'Later', goal: '', taskKeys: [] }] } };
    expect(groupByMilestone(withEmpty).map((group) => [group.key, group.tasks.length])).toEqual([['m1', 1], ['m2', 3], ['m3', 0]]);
    expect(groupByMilestone({ plan: null, tasks: [] })).toEqual([]);
  });

  it('names dependencies by title', () => {
    expect(taskTitles(['t1', 'zz'], PLAN_DETAIL.tasks)).toEqual(['Map the tax code paths', 'zz']);
  });
});

describe('the new-goal form', () => {
  const valid: GoalForm = { ...EMPTY_GOAL_FORM, title: '  Fix checkout  ', description: ' All of it. ', repos: ['web', 'desk'] };

  it('starts with a $5 budget and plan approval on', () => {
    expect(EMPTY_GOAL_FORM).toMatchObject({ budget: '5', requirePlanApproval: true, repos: [] });
  });

  it('reads dollars as typed', () => {
    expect(['5', '2.50', '$7', ' $ 1.5 ', '.5', '1000'].map(parseUsd)).toEqual([5, 2.5, 7, 1.5, 0.5, 1000]);
    expect(['', 'five', '1,5', '-1', '1e3', '5$'].map(parseUsd)).toEqual([null, null, null, null, null, null]);
  });

  it('turns a datetime-local value into an ISO date-time in the browser\'s zone', () => {
    expect(deadlineIso('2026-12-01T17:00')).toBe(new Date(2026, 11, 1, 17, 0).toISOString());
    expect(deadlineIso('')).toBeNull();
    expect(deadlineIso('not a date')).toBeNull();
  });

  it('reports every problem with an i18n key that exists', () => {
    const errors = validateGoalForm({ ...EMPTY_GOAL_FORM, budget: '0', deadline: 'garbage' });
    expect(errors).toEqual({
      title: 'goals.form.errors.titleRequired',
      description: 'goals.form.errors.descriptionRequired',
      repos: 'goals.form.errors.reposRequired',
      budget: 'goals.form.errors.budget',
      deadline: 'goals.form.errors.deadline',
    });
    const long = validateGoalForm({ ...valid, title: 'x'.repeat(201), description: 'x'.repeat(20_001), constraints: 'x'.repeat(5001), budget: '1000.01' });
    expect(long).toEqual({
      title: 'goals.form.errors.titleTooLong',
      description: 'goals.form.errors.descriptionTooLong',
      constraints: 'goals.form.errors.constraintsTooLong',
      budget: 'goals.form.errors.budget',
    });
    for (const key of [...Object.values(errors), ...Object.values(long)]) expect(has(key!)).toBe(true);
    expect(validateGoalForm(valid)).toEqual({});
    expect(validateGoalForm({ ...valid, budget: 'lots' })).toEqual({ budget: 'goals.form.errors.budget' });
  });

  it('builds the body Foreman takes: trimmed, primary repo first, empty optional fields left out', () => {
    expect(buildCreateGoalInput(valid)).toEqual({ title: 'Fix checkout', description: 'All of it.', repos: ['web', 'desk'], budgetUsd: 5, requirePlanApproval: true });
    expect(buildCreateGoalInput({ ...valid, constraints: ' no schema change ', budget: '$12.5', deadline: '2026-12-01T17:00', requirePlanApproval: false })).toEqual({
      title: 'Fix checkout',
      description: 'All of it.',
      repos: ['web', 'desk'],
      budgetUsd: 12.5,
      constraints: 'no schema change',
      deadline: new Date(2026, 11, 1, 17, 0).toISOString(),
      requirePlanApproval: false,
    });
  });

  it('reads Foreman\'s issues off a refused goal', () => {
    expect(issueLines({ details: { issues: [{ path: ['repos', 0], message: 'Unknown repo: nope' }, { message: 'Bad' }, 'plain', { path: 'title' }, 5] } })).toEqual([
      'repos.0: Unknown repo: nope',
      'Bad',
      'plain',
    ]);
    expect(issueLines(new Error('x'))).toEqual([]);
    expect(issueLines(null)).toEqual([]);
  });
});

describe('the catalog', () => {
  it('has a label for every goal status, task status, task kind and next kind the contract can send', () => {
    const families: Record<string, string[]> = {
      'goals.status': ALL_STATUSES,
      'goals.taskStatus': ['planned', 'blocked', 'ready', 'running', 'needs_user', 'completed', 'failed', 'cancelled'],
      'goals.taskKind': ['implement', 'analysis', 'synthesis', 'verify', 'checkpoint', 'fixup'],
      'goals.next': ['plan_approval', 'budget', 'question', 'task', 'judge', 'none'],
      'needs.kind': ['plan'],
    };
    const missing = Object.entries(families).flatMap(([family, names]) => names.filter((name) => !has(`${family}.${name}`)).map((name) => `${family}.${name}`));
    expect(missing).toEqual([]);
  });

  it('formats a deadline, and gives nothing for a missing one', () => {
    expect(formatDateTime('2026-12-01T17:00:00.000Z', 'en')).toMatch(/2026/);
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('nope')).toBe('');
  });
});

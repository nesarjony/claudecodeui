import type { GoalDetail, GoalListItem, GoalTaskView } from '@/modules/foreman/goals/types';
import type { InboxItem } from '@/modules/foreman/types';

/** Goals as Foreman answers them (docs/BRIDGE.md, "Goals and big work (Milestone 7)"). */

export const GOAL_PLAN_ID = 'goal_11111111-1111-4111-8111-111111111111';
export const GOAL_RUNNING_ID = 'goal_22222222-2222-4222-8222-222222222222';
export const GOAL_DONE_ID = 'goal_33333333-3333-4333-8333-333333333333';
const TRACE = (char: string) => char.repeat(32);

const item = (over: Partial<GoalListItem> & Pick<GoalListItem, 'id' | 'title' | 'status'>): GoalListItem => ({
  repos: ['desk'],
  budgetUsd: 5,
  spentUsd: 0,
  tasksDone: 0,
  tasksTotal: 0,
  playbook: 'P4',
  next: { kind: 'none', text: '', inboxId: null },
  deadline: null,
  overdue: false,
  endReason: null,
  traceId: null,
  createdAt: '2026-11-13T08:00:00.000Z',
  updatedAt: '2026-11-13T09:00:00.000Z',
  ...over,
});

export const GOALS: GoalListItem[] = [
  item({
    id: GOAL_PLAN_ID,
    title: 'Move checkout to the tax service',
    status: 'awaiting_approval',
    repos: ['desk', 'web'],
    spentUsd: 0.42,
    tasksTotal: 4,
    next: { kind: 'plan_approval', text: '', inboxId: `inb_${GOAL_PLAN_ID}_1` },
    deadline: '2099-12-01T17:00:00.000Z',
    traceId: TRACE('c'),
  }),
  item({
    id: GOAL_RUNNING_ID,
    title: 'Upgrade the payment SDK everywhere',
    status: 'running',
    spentUsd: 4.2,
    tasksDone: 2,
    tasksTotal: 5,
    playbook: 'P3',
    next: { kind: 'task', text: 'Write the migration for the tax table', inboxId: null },
    deadline: '2026-11-01T17:00:00.000Z',
    overdue: true,
  }),
  item({
    id: GOAL_DONE_ID,
    title: 'Remove the legacy cart',
    status: 'done',
    spentUsd: 5.5,
    tasksDone: 3,
    tasksTotal: 3,
    endReason: 'The judge passed run 2.',
  }),
];

const task = (over: Partial<GoalTaskView> & Pick<GoalTaskView, 'key' | 'title' | 'milestone'>): GoalTaskView => ({
  taskId: null,
  kind: 'implement',
  playbook: 'P1',
  repo: 'desk',
  dependsOn: [],
  status: 'planned',
  dod: { goal: `${over.title} works`, acceptanceCriteria: [], gateCommands: [] },
  estimatedCostUsd: 0.5,
  costUsd: 0,
  traceId: null,
  summary: null,
  ...over,
});

/** The plan waiting for approval. The tasks are deliberately NOT in dependency order: the view must order them. */
export const PLAN_DETAIL: GoalDetail = {
  ...GOALS[0]!,
  description: 'Replace the inline tax maths in checkout with calls to the tax service, behind a flag.',
  constraints: 'No schema change in desk.',
  requirePlanApproval: true,
  planNote: null,
  plan: {
    rationale: 'Read the current maths first, then swap it behind a flag, then prove both paths agree.',
    estimatedCostUsd: 3.2,
    revision: 1,
    milestones: [
      { key: 'm1', title: 'Understand', goal: 'Know every place tax is computed.', taskKeys: ['t1'] },
      { key: 'm2', title: 'Switch', goal: 'Checkout calls the tax service behind a flag.', taskKeys: ['t3', 't2', 't4'] },
    ],
  },
  tasks: [
    task({ key: 't3', title: 'Prove both paths agree', milestone: 'm2', kind: 'verify', dependsOn: ['t2'] }),
    task({ key: 't1', title: 'Map the tax code paths', milestone: 'm1', kind: 'analysis', playbook: 'P2' }),
    task({ key: 't4', title: 'Remove the old maths', milestone: 'm2', dependsOn: ['t3', 't2'] }),
    task({ key: 't2', title: 'Call the tax service behind a flag', milestone: 'm2', dependsOn: ['t1'], repo: 'web' }),
  ],
  verdicts: [],
  judgeRuns: 0,
  maxRuns: 3,
  replans: 0,
  warnedAt80: false,
  spend: { foremanUsd: 0, workerUsd: 0, goalUsd: 0.42, totalUsd: 0.42, budgetUsd: 5 },
  pending: { kind: 'plan', question: 'Approve the plan for "Move checkout to the tax service"? 4 tasks, about $3.20.', inboxId: `inb_${GOAL_PLAN_ID}_1` },
  timeline: [
    { ts: '2026-11-13T08:00:00.000Z', kind: 'plan', summary: 'Planned 2 milestones, 4 tasks.', traceId: TRACE('d') },
  ],
};

/** A goal at work: a judge run that did not pass and added a fix-up, a re-plan, the 80% warning. */
export const RUNNING_DETAIL: GoalDetail = {
  ...GOALS[1]!,
  description: 'Bump the payment SDK to v5 in desk and fix what breaks.',
  constraints: null,
  requirePlanApproval: false,
  planNote: 'Keep the old webhook endpoint.',
  plan: {
    rationale: 'Bump, then fix the call sites, then run the payment e2e.',
    estimatedCostUsd: 4,
    revision: 2,
    milestones: [
      { key: 'm1', title: 'Bump', goal: 'The SDK is on v5.', taskKeys: ['t1', 't2'] },
      { key: 'm2', title: 'Fix', goal: 'Every call site works.', taskKeys: ['t3', 't4'] },
    ],
  },
  tasks: [
    task({ key: 't1', taskId: 'task-41', title: 'Bump the SDK', milestone: 'm1', status: 'completed', costUsd: 0.3, estimatedCostUsd: 0.4, traceId: TRACE('e'), summary: 'Bumped to 5.1.0; lockfile updated.', dod: { goal: 'The SDK is on v5', acceptanceCriteria: ['package.json pins ^5', 'the lockfile is updated'], gateCommands: ['pnpm install --frozen-lockfile', 'pnpm verify'] } }),
    task({ key: 't2', taskId: 'task-42', title: 'Fix the refund call', milestone: 'm1', status: 'completed', dependsOn: ['t1'], costUsd: 0.6 }),
    task({ key: 't3', taskId: 'task-43', title: 'Fix the webhook handler', milestone: 'm2', status: 'running', dependsOn: ['t1'], costUsd: 0.9 }),
    task({ key: 't4', title: 'Run the payment e2e', milestone: 'm2', status: 'blocked', dependsOn: ['t2', 't3'], kind: 'verify' }),
    task({ key: 'f1', title: 'Add the missing refund test', milestone: 'fixups', status: 'ready', kind: 'fixup', dependsOn: ['t2'] }),
  ],
  verdicts: [
    {
      run: 1,
      passed: false,
      reasoning: 'Refunds are not covered by a test.',
      unmet: ['A test covers refunds on v5'],
      feedback: 'Add a refund test before judging again.',
      fixupKeys: ['f1'],
      model: 'api-sonnet',
      costUsd: 0.12,
      traceId: TRACE('f'),
      at: '2026-11-13T08:50:00.000Z',
    },
  ],
  judgeRuns: 1,
  maxRuns: 3,
  replans: 1,
  warnedAt80: true,
  spend: { foremanUsd: 0.8, workerUsd: 3, goalUsd: 0.4, totalUsd: 4.2, budgetUsd: 5 },
  pending: null,
  timeline: Array.from({ length: 10 }, (_, index) => ({
    ts: `2026-11-13T08:${String(10 + index).padStart(2, '0')}:00.000Z`,
    kind: index === 9 ? 'judge' : 'task',
    summary: `Step ${index + 1} of the goal.`,
    traceId: null,
  })),
};

export const PAUSED_ON_QUESTION: GoalDetail = {
  ...RUNNING_DETAIL,
  status: 'paused',
  next: { kind: 'question', text: 'A part failed again after its re-plan.', inboxId: `inb_${GOAL_RUNNING_ID}_2` },
  pending: { kind: 'question', question: 'Fixing the webhook handler failed twice. Continue with guidance, or fail the goal?', inboxId: `inb_${GOAL_RUNNING_ID}_2` },
};

export const PAUSED_ON_BUDGET: GoalDetail = {
  ...RUNNING_DETAIL,
  status: 'paused',
  spentUsd: 5.1,
  spend: { ...RUNNING_DETAIL.spend, totalUsd: 5.1 },
  pending: { kind: 'budget', question: 'The goal spent its $5.00 budget.', inboxId: `inb_${GOAL_RUNNING_ID}_3` },
};

export const PAUSED_BY_USER: GoalDetail = { ...RUNNING_DETAIL, status: 'paused', pending: null };

export const DONE_DETAIL: GoalDetail = { ...RUNNING_DETAIL, ...GOALS[2]!, pending: null };

export const PLAN_INBOX_ITEM: InboxItem = {
  id: `inb_${GOAL_PLAN_ID}_1`,
  kind: 'plan',
  taskId: GOAL_PLAN_ID,
  goalId: GOAL_PLAN_ID,
  title: 'Move checkout to the tax service',
  question: 'Approve the plan? 4 tasks, about $3.20.',
  options: ['approve', 'reject'],
  createdAt: '2026-11-13T09:20:00.000Z',
};

export const GOAL_QUESTION_ITEM: InboxItem = {
  id: `inb_${GOAL_RUNNING_ID}_2`,
  kind: 'question',
  taskId: GOAL_RUNNING_ID,
  goalId: GOAL_RUNNING_ID,
  title: 'Upgrade the payment SDK everywhere',
  question: 'Fixing the webhook handler failed twice. Continue with guidance, or fail the goal?',
  options: ['continue', 'fail'],
  createdAt: '2026-11-13T09:22:00.000Z',
};

export const TWO_REPO_CONFIG_REPOS = [
  { name: 'desk', path: '/mnt/dev/moveon/desk' },
  { name: 'web', path: '/mnt/dev/moveon/web' },
];

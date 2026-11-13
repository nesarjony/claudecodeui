import type {
  ConfigOptions,
  ConfigResponse,
  DecisionItem,
  ForemanConfig,
  ForemanRole,
  InboxItem,
  Lesson,
  Overview,
  SpendReport,
  TaskDetail,
  TaskSummary,
} from '@/modules/foreman/types';

export const ROLES: ForemanRole[] = ['planner', 'strategist', 'supervisor', 'judge', 'contextKeeper', 'researcher'];
const role = (model: string, escalate: string[] = [], effort = 'medium') => ({ model, escalate, effort, promptVersion: 'v1' });

export const CONFIG = {
  mode: 'shadow',
  repos: [{ name: 'desk', path: '/mnt/dev/moveon/desk' }],
  maxConcurrentSessions: 2,
  perRepo: 1,
  budgets: { perTaskUsd: 3, perDayUsd: 25 },
  autoAnswerConfidence: 0.8,
  models: {
    planner: role('api-opus', [], 'high'),
    strategist: role('api-haiku', ['api-sonnet']),
    supervisor: role('api-haiku', ['api-sonnet', 'api-opus']),
    judge: role('api-sonnet', [], 'high'),
    contextKeeper: role('api-haiku', [], 'low'),
    researcher: role('api-sonnet'),
  },
  context: { notesAt: 0.35, actAt: 0.55 },
  evals: { decisionQualityRate: 1 },
  escalation: { confidenceBelow: 0.6, riskAtLeast: 'medium', maxSteps: 1 },
  workerBilling: 'api-key',
} as unknown as ForemanConfig;

export const OPTIONS: ConfigOptions = {
  modelAliases: ['api-opus', 'api-sonnet', 'api-haiku'],
  roles: ROLES,
  efforts: ['low', 'medium', 'high'],
  risks: ['low', 'medium', 'high'],
  modes: ['shadow', 'autonomous'],
};

export const CONFIG_RESPONSE: ConfigResponse = { config: CONFIG, options: OPTIONS };

export const overview = (over: Partial<Overview> = {}): Overview => ({
  mode: 'shadow',
  killed: false,
  budgets: { today: { foremanUsd: 0.07, workerUsd: 1.25, limitUsd: 25 } },
  activeTasks: 1,
  needsUserCount: 2,
  agreement7d: { key: 'all', answered: 8, sent: 5, edited: 1, dismissed: 2, acceptanceRate: 0.625, usedRate: 0.75, meanValue: 0.69 },
  ...over,
});

export const DECISIONS: DecisionItem[] = [
  { id: 'sug_aaaaaaaa-0000-0000-0000-000000000001', ts: '2026-11-13T09:30:00.000Z', sessionId: 'session-1', taskId: null, action: 'demand_evidence', reason: 'No test ran after the last edit, so there is no proof it works.', confidence: 0.92, risk: 'low', status: 'pending', model: 'api-haiku', traceId: 'a'.repeat(32), kind: 'suggestion', escalated: false, detail: 'Run pnpm verify and paste the output.' },
  { id: 'sug_bbbbbbbb-0000-0000-0000-000000000002', ts: '2026-11-13T09:10:00.000Z', sessionId: 'session-2', taskId: 'task-9', action: 'needs_user', reason: 'Deploys to production.', confidence: 0.41, risk: 'high', status: 'dismissed', model: 'api-sonnet', traceId: null, kind: 'suggestion', escalated: true, detail: 'Deploy now?' },
];

export const TASKS: TaskSummary[] = [
  { id: 'task-1', title: 'Fix the checkout total rounding', repo: '/mnt/dev/moveon/desk', status: 'running', playbook: 'bugfix', sessionId: 'session-1', costUsd: 0.42, startedAt: '2026-11-13T08:00:00.000Z', updatedAt: '2026-11-13T09:00:00.000Z', lastDecision: { action: 'steer', reason: 'Add a regression test first.' } },
  { id: 'task-2', title: 'Upgrade the date library', repo: '/mnt/dev/moveon/desk', status: 'done', playbook: 'chore', sessionId: 'session-2', costUsd: 1.1, updatedAt: '2026-11-12T20:00:00.000Z', lastDecision: 'run_judge: passed' },
];

export const TASK_DETAIL: TaskDetail = {
  ...TASKS[0]!,
  dod: [{ text: 'pnpm verify passes', met: true }, { text: 'A regression test covers the rounding', met: false }],
  timeline: [
    { ts: '2026-11-13T08:05:00.000Z', kind: 'decision', summary: 'Steer: add a regression test first.', traceId: 'b'.repeat(32) },
    { ts: '2026-11-13T08:30:00.000Z', kind: 'gate', summary: 'pnpm verify failed on lint.' },
  ],
};

export const INBOX: InboxItem[] = [
  { id: 'inb_q1', kind: 'question', taskId: 'task-1', sessionId: 'session-1', title: 'Which database?', question: 'Should the migration run against staging or the local copy?', createdAt: '2026-11-13T09:20:00.000Z' },
  { id: 'inb_p1', kind: 'permission', taskId: 'task-1', sessionId: 'session-1', title: 'Run git push --force?', question: 'The worker wants to force-push the branch.', createdAt: '2026-11-13T09:25:00.000Z' },
];

export const LESSONS: Lesson[] = [
  { id: 'les_1', repo: 'desk', text: 'Run pnpm verify before claiming a fix is done.', status: 'active', confidence: 0.9, uses: 4, evidence: ['task-1 failed lint after a green test run', 'task-7 repeated it'] },
  { id: 'les_2', repo: 'web', text: 'The web repo needs node 22.', status: 'active', confidence: 0.7, uses: 1, evidence: [] },
];

const row = (key: string, costUsd: number) => ({ key, calls: 3, inputTokens: 4000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const wrow = (key: string, costUsd: number) => ({ key, turns: 2, inputTokens: 4000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, toolCalls: 7, toolErrors: 0 });

export const spend = (range: SpendReport['range'] = 'today'): SpendReport => ({
  range,
  since: '2026-11-13T00:00:00.000Z',
  foreman: { byRole: [row('supervisor', 0.05), row('scorer:decision-quality', 0.02)], byModel: [row('api-haiku', 0.04), row('api-sonnet', 0.03)], total: 0.07, calls: 6 },
  worker: { byModel: [wrow('claude-sonnet-5-5', 1.25)], byTask: [wrow('task-1', 1.0), wrow('(none)', 0.25)], bySession: [wrow('session-1', 1.25)], total: 1.25, turns: 2 },
});

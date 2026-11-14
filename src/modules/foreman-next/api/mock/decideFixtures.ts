import type { DecisionRecord, HistoryEntry, OwnerQuestion, ReviewItem } from '@/modules/foreman-next/api/contract';
import { at, DAY_MS, HOUR_MS, MINUTE_MS } from '@/modules/foreman-next/api/mock/time';

/** Used by the mock store as the owner's blocking questions (Decide > Needs you). */
export const questionsFixture = (now: number): OwnerQuestion[] => [
  {
    id: 'q-bulk',
    title: 'Bulk actions in v1?',
    repo: 'desk',
    goalId: 'g-inbox',
    goal: 'desk · Inbox',
    delegationKind: 'product-scope',
    delegationLevel: 'ask',
    delegable: true,
    holdsRows: 20,
    askedAt: at(now, -2 * HOUR_MS),
    context:
      "Libredesk's list supports bulk assign, bulk close and bulk tag. Inbox rows 88-94 and 97-109 depend on which of these desk ships in v1.",
    options: [
      { id: 'A', label: 'All three: assign, close, tag', rowsDelta: 20, cost: '+1 endpoint', risk: 'low' },
      { id: 'B', label: 'Assign and close; tag later', rowsDelta: 14, cost: '6 deferred', risk: 'low' },
      { id: 'C', label: 'None in v1', rowsDelta: 0, cost: '20 deferred', risk: 'visible parity gap' },
    ],
    recommendation: {
      optionId: 'A',
      confidence: 0.7,
      reason: 'You decided "parity first, defer nothing visible" on 11-02, and chose the full option in 3 similar cases.',
      similar: [
        { id: 'h-parity', title: 'Parity first: defer nothing visible', decidedAt: at(now, -12 * DAY_MS), choice: 'Full option' },
        { id: 'h-filters', title: 'Saved filters in the list', decidedAt: at(now, -9 * DAY_MS), choice: 'Full option' },
        { id: 'h-export', title: 'CSV export of conversations', decidedAt: at(now, -5 * DAY_MS), choice: 'Full option' },
      ],
    },
    ifUnanswered: 't3-bulk stays held. Nothing else waits on this.',
  },
  {
    id: 'q-realtime',
    title: 'Realtime transport',
    repo: 'desk',
    goalId: 'g-inbox',
    goal: 'desk · Inbox',
    delegationKind: 'product-scope',
    delegationLevel: 'ask',
    delegable: true,
    holdsRows: 15,
    askedAt: at(now, -2 * HOUR_MS - 10 * MINUTE_MS),
    context: 'Live updates in the conversation list can use WebSocket or server-sent events. Rows 110-124 differ by transport.',
    options: [
      { id: 'A', label: 'WebSocket', rowsDelta: 15, cost: '+1 service', risk: 'medium' },
      { id: 'B', label: 'Server-sent events', rowsDelta: 15, cost: 'no new service', risk: 'low' },
      { id: 'C', label: 'Polling', rowsDelta: 9, cost: '6 deferred', risk: 'visible lag' },
    ],
    recommendation: {
      optionId: 'B',
      confidence: 0.6,
      reason: 'Libredesk streams over server-sent events, and you kept the donor mechanism in 2 of 3 similar cases.',
      similar: [
        { id: 'h-donor', title: 'Keep the donor mechanism where it works', decidedAt: at(now, -15 * DAY_MS), choice: 'Donor' },
        { id: 'h-auth', title: 'Session handling', decidedAt: at(now, -8 * DAY_MS), choice: 'Donor' },
      ],
    },
    ifUnanswered: 'Rows 110-124 stay held. The batches before them keep running.',
  },
];

/** Used by the budget-paused scenario: the owner-only question that lifts the pause, which can never be delegated. */
export const ceilingQuestion = (now: number): OwnerQuestion => ({
  id: 'q-ceiling',
  title: 'Raise the monthly API ceiling?',
  repo: 'desk',
  goalId: 'g-inbox',
  goal: 'desk · Inbox',
  delegationKind: 'charter',
  delegationLevel: 'ask',
  delegable: false,
  holdsRows: 55,
  askedAt: at(now, -20 * MINUTE_MS),
  context: 'The $200 API ceiling is reached for this month. Foreman resumes on the 1st, or as soon as you raise it.',
  options: [
    { id: 'A', label: 'Raise it to $260 this month', rowsDelta: 55, cost: '+$60', risk: 'over the plan' },
    { id: 'B', label: 'Wait for the 1st', rowsDelta: 0, cost: 'none', risk: 'Inbox slips by two weeks' },
  ],
  recommendation: null,
  ifUnanswered: 'Everything stays paused until the 1st.',
});

/** Used by the mock store as the items Foreman decided alone, each with its veto window (Decide > Review). */
export const reviewFixture = (now: number): ReviewItem[] => [
  {
    id: 'r-rule',
    kind: 'rule',
    subject: { kind: 'rule', id: 'rule-hooks-state-reset' },
    title: 'Adopted rule hooks/state-reset in desk',
    evidence: 'E7 · +18 points over 12 rows',
    detail: 'Rule: reset local state when the entity id changes. Added as .claude/rules/hooks-state.md in desk. The judge failed 3 rows in hooks/ for stale state; the 6 rows since pass.',
    closesAt: at(now, 3 * HOUR_MS + 12 * MINUTE_MS),
  },
  {
    id: 'r-lesson',
    kind: 'lesson',
    subject: { kind: 'lesson', id: 'lesson-ui-copy-i18n' },
    title: 'New lesson: all UI copy comes from i18n',
    evidence: 'from 2 judge failures',
    detail: 'Do: take every user-visible string from the i18n catalogue. Do not: hard-code English in components, even in empty states. Rows 11 and 36 failed for hard-coded copy.',
    closesAt: at(now, 7 * HOUR_MS),
  },
  {
    id: 'r-replan',
    kind: 'replan',
    subject: { kind: 'goal', id: 'g-inbox' },
    title: 'Re-planned desk · Inbox (strategy v2)',
    evidence: 'after your scope answer',
    detail: 'Strategy v2 puts the fix batch first, then the contract batch, then layout, components and integration. Rows 88-94 move behind your bulk-actions answer.',
    closesAt: at(now, 52 * MINUTE_MS),
  },
  {
    id: 'r-retry',
    kind: 'delegated-decision',
    subject: { kind: 'decision', id: 'h-retry-1' },
    title: 'Retried t1-status-filter after a judge failure',
    evidence: 'retry-batch · decide, tell me (6h veto)',
    detail: 'Row 11 failed on hard-coded copy. Foreman sent the batch back with the judge\'s reason, and the second round passed.',
    closesAt: at(now, 5 * HOUR_MS),
  },
];

/** Used by the mock store as the decisions already made (Decide > History). */
export const historyFixture = (now: number): HistoryEntry[] => [
  { id: 'dec-steer-9', title: 'Steer at turn 9 · t2-layout', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: null, decidedAt: at(now, -40 * MINUTE_MS), decidedBy: 'foreman', choice: 'Steer', agreedWithRecommendation: null },
  { id: 'h-retry-1', title: 'Retried t1-status-filter after a judge failure', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: 'retry-batch', decidedAt: at(now, -1 * HOUR_MS), decidedBy: 'foreman', choice: 'Retry', agreedWithRecommendation: null },
  { id: 'h-scope-i18n', title: 'Which languages ship in v1?', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: 'product-scope', decidedAt: at(now, -1 * DAY_MS), decidedBy: 'owner', choice: 'English only', agreedWithRecommendation: true },
  { id: 'h-replan-1', title: 'Re-plan Inbox after the scope answer', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: 'replan-goal', decidedAt: at(now, -1 * DAY_MS - 2 * HOUR_MS), decidedBy: 'foreman', choice: 'Re-plan', agreedWithRecommendation: null },
  { id: 'h-export', title: 'CSV export of conversations', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: 'product-scope', decidedAt: at(now, -5 * DAY_MS), decidedBy: 'owner', choice: 'Full option', agreedWithRecommendation: true },
  { id: 'h-auth', title: 'Session handling', goalId: 'g-inbox', goal: 'desk · Inbox', delegationKind: 'product-scope', decidedAt: at(now, -8 * DAY_MS), decidedBy: 'owner', choice: 'Donor', agreedWithRecommendation: false },
];

/** Used by the mock store as the decision cards behind runs, history and chat links. */
export const decisionsFixture = (now: number): DecisionRecord[] => [
  {
    id: 'dec-steer-9',
    kind: 'worker-progress',
    delegationKind: null,
    goalId: 'g-inbox',
    runId: 'run-t2',
    title: 'Steer at turn 9 · t2-layout',
    maker: { type: 'role', role: 'supervisor', version: 2 },
    model: 'Opus',
    costUsd: 0.04,
    durationMs: 3100,
    traceUrl: 'http://127.0.0.1:4111/traces/a1b2c3',
    saw: 'The worker added a second fetch in InboxLayout.tsx (+38 lines) while useConversationList already loads the same data.',
    used: ['lesson "one data source per list"', 'desk convention: state management'],
    considered: ['continue (the duplicate fetch would reach the judge)', 'steer', 'ask you'],
    chose: 'steer: "Reuse useConversationList; don\'t add a second fetch."',
    outcome: 'The worker removed the fetch at turn 10. Row 7 passed on the first try.',
    feedback: null,
  },
  ...historyFixture(now)
    .filter((entry) => entry.id !== 'dec-steer-9')
    .map(
      (entry): DecisionRecord => ({
        id: entry.id,
        kind: entry.decidedBy === 'owner' ? 'owner-question' : 'rework',
        delegationKind: entry.delegationKind,
        goalId: entry.goalId,
        runId: null,
        title: entry.title,
        maker: entry.decidedBy === 'owner' ? { type: 'owner' } : { type: 'role', role: 'supervisor', version: 2 },
        model: entry.decidedBy === 'owner' ? null : 'Opus',
        costUsd: entry.decidedBy === 'owner' ? 0 : 0.11,
        durationMs: entry.decidedBy === 'owner' ? 0 : 5200,
        traceUrl: null,
        saw: `A decision was needed on "${entry.title}" for ${entry.goal}.`,
        used: ['your earlier decisions on parity'],
        considered: ['the options that were on the card'],
        chose: entry.choice,
        outcome: 'Work continued without a follow-up question.',
        feedback: null,
      }),
    ),
];

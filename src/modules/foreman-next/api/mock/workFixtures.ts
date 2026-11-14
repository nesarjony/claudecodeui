import type { BatchEntry, GoalDetail, RunDetail } from '@/modules/foreman-next/api/contract';
import { at, DAY_MS, HOUR_MS } from '@/modules/foreman-next/api/mock/time';

const BATCH_NAMES = [
  't0-fixes',
  't0b-contract',
  't1-status-filter',
  't2-layout',
  't3-bulk',
  't4-list-items',
  't5-realtime',
  't6-filters',
  't7-search',
  't8-assign',
  't9-tags',
  't10-polish',
  't11-integration',
];

function inboxBatches(): BatchEntry[] {
  const doneRuns: Record<number, BatchEntry['firstPass']> = { 1: { passed: 3, of: 3 }, 2: { passed: 5, of: 5 }, 3: { passed: 9, of: 10 } };
  return BATCH_NAMES.map((name, position): BatchEntry => {
    const index = position + 1;
    const base = { index, name, rows: 6, turn: null, costUsd: null, firstPass: null, waitsOn: null, runId: null };
    if (index <= 3) return { ...base, rows: [3, 5, 10][position] ?? 6, state: 'done', costUsd: [0.31, 0.52, 0.88][position] ?? 0, firstPass: doneRuns[index] ?? null, runId: index === 3 ? 'run-t1' : null };
    if (index === 4) return { ...base, state: 'running', turn: 14, costUsd: 0.2, runId: 'run-t2' };
    if (index === 5) return { ...base, rows: 20, state: 'waiting', waitsOn: { questionId: 'q-bulk', title: 'Bulk actions in v1?' } };
    if (index === 7) return { ...base, rows: 15, state: 'waiting', waitsOn: { questionId: 'q-realtime', title: 'Realtime transport' } };
    return { ...base, state: 'queued' };
  });
}

const INBOX_STRATEGY_V2 = {
  version: 2,
  reason: 'after your scope answer',
  steps: [
    'Fix batch first: rows 42, 76, 79, held from the earlier run',
    'Contract batch: the 5 missing endpoints, before rows that use them',
    'Layout, then components, then integration',
  ],
  risks: ['realtime rows wait on your transport decision', '33 rows have no donor tests'],
};

/** Used by the mock store as the Work board: the Inbox goal in full, plus the queued and finished goals. */
export const goalsFixture = (now: number): GoalDetail[] => [
  {
    id: 'g-inbox',
    repo: 'desk',
    name: 'Inbox',
    title: 'desk · Inbox at 100% Libredesk parity',
    doneWhen: 'all 120 checklist rows are DONE and verified by the judge',
    state: 'active',
    done: 65,
    total: 120,
    counts: { done: 65, built: 3, todo: 52 },
    forecast: { batchesLeft: 9, usdToGo: 11, minimaxWindows: 4, doneBy: at(now, 3 * DAY_MS), certainty: 'likely' },
    waitsOnYou: { decisions: 2, rowsHeld: 35 },
    batch: { current: 4, total: 13 },
    queuedAfter: null,
    hasStrategy: true,
    spentUsd: 12.4,
    daysTaken: null,
    spent: { usd: 12.4, shareUsd: 40, firstPassYield: 91, usdPerRow: 0.38 },
    strategy: {
      ...INBOX_STRATEGY_V2,
      replannedAt: at(now, -3 * HOUR_MS),
      status: 'in-review',
      previous: { version: 1, steps: ['Layout first, then components', 'Contract batch before integration', 'Fix batch last'] },
    },
    batches: inboxBatches(),
  },
  {
    id: 'g-contacts',
    repo: 'desk',
    name: 'Contacts',
    title: 'desk · Contacts at 100% Libredesk parity',
    doneWhen: 'all 96 checklist rows are DONE and verified by the judge',
    state: 'queued',
    done: 0,
    total: 96,
    counts: { done: 0, built: 0, todo: 96 },
    forecast: null,
    waitsOnYou: { decisions: 0, rowsHeld: 0 },
    batch: null,
    queuedAfter: 'Inbox',
    hasStrategy: false,
    spentUsd: 0,
    daysTaken: null,
    spent: { usd: 0, shareUsd: 30, firstPassYield: 0, usdPerRow: 0 },
    strategy: null,
    batches: [],
  },
  {
    id: 'g-conversation',
    repo: 'desk',
    name: 'Conversation',
    title: 'desk · Conversation at 100% Libredesk parity',
    doneWhen: 'all 140 checklist rows are DONE and verified by the judge',
    state: 'queued',
    done: 0,
    total: 140,
    counts: { done: 0, built: 0, todo: 140 },
    forecast: null,
    waitsOnYou: { decisions: 0, rowsHeld: 0 },
    batch: null,
    queuedAfter: 'Contacts',
    hasStrategy: false,
    spentUsd: 0,
    daysTaken: null,
    spent: { usd: 0, shareUsd: 45, firstPassYield: 0, usdPerRow: 0 },
    strategy: null,
    batches: [],
  },
  {
    id: 'g-demo',
    repo: 'scratch',
    name: 'demo',
    title: 'scratch · demo at 100% parity',
    doneWhen: 'all 12 checklist rows are DONE and verified by the judge',
    state: 'done',
    done: 12,
    total: 12,
    counts: { done: 12, built: 0, todo: 0 },
    forecast: null,
    waitsOnYou: { decisions: 0, rowsHeld: 0 },
    batch: null,
    queuedAfter: null,
    hasStrategy: true,
    spentUsd: 3.1,
    daysTaken: 2,
    spent: { usd: 3.1, shareUsd: 5, firstPassYield: 83, usdPerRow: 0.26 },
    strategy: { version: 1, replannedAt: at(now, -6 * DAY_MS), reason: 'first plan', status: 'approved', steps: ['Build the 12 rows in two batches'], risks: [], previous: null },
    batches: [],
  },
];

const STAGES_AT_WORKER: RunDetail['stages'] = [
  { id: 'brief', state: 'done' },
  { id: 'worker', state: 'running' },
  { id: 'checks', state: 'pending' },
  { id: 'judge', state: 'pending' },
  { id: 'close', state: 'pending' },
];

const runsBase = (): RunDetail[] => [
  {
    id: 'run-t2',
    kind: 'worker',
    goalId: 'g-inbox',
    goal: 'desk · Inbox',
    batch: 't2-layout',
    model: 'MiniMax-M3',
    sandboxed: true,
    turn: 14,
    elapsedMinutes: 23,
    minimaxWindowPct: 3,
    state: 'running',
    stages: STAGES_AT_WORKER,
    nextCheck: 'when the worker says done, asks something, or goes 10 turns without a commit',
    control: 'foreman',
    sessionId: 'sess-t2-layout',
    failure: null,
    decisions: [
      { turn: 1, choice: 'continue', maker: { type: 'code' }, model: null, costUsd: null, quote: null, cardId: null },
      { turn: 5, choice: 'continue', maker: { type: 'code' }, model: null, costUsd: null, quote: null, cardId: null },
      {
        turn: 9,
        choice: 'steer',
        maker: { type: 'role', role: 'supervisor', version: 2 },
        model: 'Opus',
        costUsd: 0.04,
        quote: "Reuse useConversationList; don't add a second fetch.",
        cardId: 'dec-steer-9',
      },
      { turn: 14, choice: 'continue', maker: { type: 'code' }, model: null, costUsd: null, quote: null, cardId: null },
    ],
    worker: {
      now: 'editing InboxLayout.tsx',
      changed: { files: 4, added: 212, removed: 31 },
      tools: ['Read', 'Edit', 'Bash(pnpm test)'],
      says: 'rows 4 and 7 built',
    },
    verdict: null,
  },
  {
    id: 'run-t1',
    kind: 'worker',
    goalId: 'g-inbox',
    goal: 'desk · Inbox',
    batch: 't1-status-filter',
    model: 'MiniMax-M3',
    sandboxed: true,
    turn: 22,
    elapsedMinutes: 47,
    minimaxWindowPct: 0,
    state: 'done',
    stages: [
      { id: 'brief', state: 'done' },
      { id: 'worker', state: 'done' },
      { id: 'checks', state: 'done' },
      { id: 'judge', state: 'done' },
      { id: 'close', state: 'done' },
    ],
    nextCheck: 'the run is closed',
    control: 'foreman',
    sessionId: 'sess-t1-status-filter',
    failure: null,
    decisions: [{ turn: 22, choice: 'pass', maker: { type: 'role', role: 'judge', version: 4 }, model: 'Opus', costUsd: 0.12, quote: null, cardId: null }],
    worker: null,
    verdict: {
      check: { command: 'pnpm verify', exitCode: 0, cleanCopy: true, outputUrl: 'http://127.0.0.1:4111/artifacts/t1-verify' },
      rows: [
        { row: 4, passed: true, note: null },
        { row: 7, passed: true, note: null },
        { row: 81, passed: true, note: null },
        { row: 82, passed: true, note: null },
        { row: 83, passed: false, note: 'header 8px taller' },
        { row: 84, passed: true, note: null },
      ],
      verdictUrl: 'http://127.0.0.1:4111/verdicts/t1',
      next: 'row 83 goes back to the worker with the judge\'s reason',
    },
  },
  {
    id: 'run-ho-boss',
    kind: 'handed-over',
    goalId: null,
    goal: 'finish the Contacts import',
    batch: 'desk boss',
    model: 'Opus',
    sandboxed: false,
    turn: 31,
    elapsedMinutes: 52,
    minimaxWindowPct: 0,
    state: 'running',
    stages: [
      { id: 'attach', state: 'done' },
      { id: 'worker', state: 'running' },
      { id: 'checks', state: 'pending' },
      { id: 'judge', state: 'pending' },
      { id: 'close', state: 'pending' },
    ],
    nextCheck: 'when the session says done, asks something, or goes 10 turns without a commit',
    control: 'foreman',
    sessionId: 'sess-desk-boss',
    failure: null,
    decisions: [
      { turn: 24, choice: 'continue', maker: { type: 'code' }, model: null, costUsd: null, quote: null, cardId: null },
      { turn: 31, choice: 'continue', maker: { type: 'code' }, model: null, costUsd: null, quote: null, cardId: null },
    ],
    worker: { now: 'editing ContactImport.tsx', changed: { files: 3, added: 96, removed: 12 }, tools: ['Read', 'Edit', 'Bash(pnpm test)'], says: 'import mapping done, tests next' },
    verdict: null,
  },
];

export const RUN_FAILURE: NonNullable<RunDetail['failure']> = {
  stage: 'worker',
  reason: 'The worker stopped after a model refusal on turn 14 and made no commit.',
  next: 'retry',
};

/** Used by the mock store as the live run (t2-layout), a judge run (j3-judge), a finished run (t1-status-filter) with its checks and verdict, and a session the owner handed over (desk boss). */
export const runsFixture = (): RunDetail[] => {
  const runs = runsBase();
  const finished = runs.find((run) => run.id === 'run-t1');
  if (!finished) return runs;
  const judging: RunDetail = {
    ...finished,
    id: 'run-j3',
    batch: 'j3-judge',
    turn: 6,
    elapsedMinutes: 2,
    state: 'running',
    stages: finished.stages.map((stage) => (stage.id === 'judge' ? { ...stage, state: 'running' } : stage.id === 'close' ? { ...stage, state: 'pending' } : stage)),
    nextCheck: 'when the judge has graded every row',
    sessionId: null,
    decisions: [],
    verdict: null,
  };
  return [...runs, judging];
};

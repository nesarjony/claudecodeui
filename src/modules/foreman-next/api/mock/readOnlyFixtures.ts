import type { GoalDetail } from '@/modules/foreman-next/api/contract';
import { at, DAY_MS, HOUR_MS } from '@/modules/foreman-next/api/mock/time';

/** Used by the mock store as a goal on a read-only repo (desk): planned and approved, it waits for the owner's switch, and the repo says how far its rows are. */
export const readOnlyGoalFixture = (now: number): GoalDetail => ({
  id: 'g-reports',
  repo: 'desk',
  name: 'Reports',
  title: 'desk · Reports at 100% Libredesk parity',
  doneWhen: 'all 40 checklist rows are DONE and verified by the judge',
  state: 'read-only',
  done: 18,
  total: 40,
  counts: { done: 18, built: 2, todo: 20 },
  forecast: { batchesLeft: 4, usdToGo: 5, minimaxWindows: 2, doneBy: at(now, 6 * DAY_MS), certainty: 'uncertain' },
  waitsOnYou: { decisions: 0, rowsHeld: 0 },
  batch: null,
  queuedAfter: null,
  hasStrategy: true,
  readOnly: { repo: 'desk' },
  spentUsd: 1.2,
  daysTaken: null,
  spent: { usd: 1.2, shareUsd: 20, firstPassYield: 0, usdPerRow: 0 },
  study: null,
  strategy: { version: 1, replannedAt: at(now, -3 * DAY_MS), reason: 'first plan', status: 'approved', steps: ['Build the report screens in four batches'], risks: ['desk is read-only: the rows move when your own pipeline judges them'], previous: null },
  batches: [],
  repoProgress: [
    { repoHead: 'a1b2c3d', rowsDone: 11, rowsPlanned: 40, complete: false, recordedAt: at(now, -3 * DAY_MS) },
    { repoHead: 'e4f5a6b', rowsDone: 14, rowsPlanned: 40, complete: false, recordedAt: at(now, -2 * DAY_MS) },
    { repoHead: '9c8d7e6', rowsDone: 18, rowsPlanned: 40, complete: false, recordedAt: at(now, -HOUR_MS) },
  ],
});

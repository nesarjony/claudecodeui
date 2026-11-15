import type { AlertItem, ForemanStatus, TodaySnapshot } from '@/modules/foreman-next/api/contract';
import { at, DAY_MS, HOUR_MS, MINUTE_MS } from '@/modules/foreman-next/api/mock/time';

/** Used by the mock store as the status strip's starting state. */
export const statusFixture = (): ForemanStatus => ({
  state: 'running',
  pauseReason: null,
  resumesAt: null,
  spend: { monthUsd: 41.2, ceilingUsd: 200, paceUsdPerDay: 6.5 },
  minimax: { fiveHourPct: 34, weeklyPct: 12 },
  alerts: 1,
  blockingDecisions: 2,
  degraded: [],
  studioUrl: 'http://127.0.0.1:4111',
});

/** Used by the mock store as the Today briefing, weekly trend and running batches. */
export const todayFixture = (now: number): TodaySnapshot => ({
  briefing: {
    generatedAt: at(now, -2 * HOUR_MS),
    sentences: [
      'Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.',
      'It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).',
      '2 decisions need you. Together they hold 35 rows; everything else is moving.',
      'Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.',
    ],
  },
  trend: [
    { id: 'first-pass-yield', previous: 84, current: 91, of: null },
    { id: 'usd-per-row', previous: 0.46, current: 0.38, of: null },
    { id: 'agreed', previous: null, current: 11, of: 12 },
    { id: 'false-stops', previous: null, current: 0, of: null },
  ],
  running: [
    { id: 'run-t2', kind: 'worker', batch: 't2-layout', stage: 'worker', turn: 14, rows: null, elapsedMinutes: 23, turnsWithoutCommit: 9 },
    { id: 'run-j3', kind: 'worker', batch: 'j3-judge', stage: 'judge', turn: null, rows: 6, elapsedMinutes: 2, turnsWithoutCommit: null },
  ],
});

/** Used by the mock store for the service log dialog. */
export const serviceLogFixture = (now: number): string[] =>
  [
    [-3 * DAY_MS, 'foreman.service started, pid 2214'],
    [-6 * HOUR_MS, 'scheduler: tick, 1 goal active'],
    [-2 * HOUR_MS, 'inbox: 2 owner questions pending'],
    [-20 * MINUTE_MS, 'run t2-layout: turn 14 recorded, decision continue (code)'],
  ].map(([offset, line]) => `${at(now, Number(offset))} ${line}`);

/** Used by the mock store as the alerts behind the status strip's count. */
export const alertsFixture = (now: number): AlertItem[] => [
  { id: 'al-stuck', severity: 'warning', text: 't2-layout went 9 turns without a commit', at: at(now, -12 * MINUTE_MS), subject: { kind: 'run', id: 'run-t2' } },
];

import { DEGRADED_MODES } from '@/modules/foreman-next/api/contract';
import type { DegradedMode } from '@/modules/foreman-next/api/contract';
import type { MockStore } from '@/modules/foreman-next/api/mock/mockStore';
import { ceilingQuestion } from '@/modules/foreman-next/api/mock/decideFixtures';
import { RUN_FAILURE } from '@/modules/foreman-next/api/mock/workFixtures';
import { at, HOUR_MS } from '@/modules/foreman-next/api/mock/time';

export type MockScenario =
  | 'default'
  | 'empty'
  | 'quiet'
  | 'budget-paused'
  | 'plan-window-paused'
  | 'deepseek-unread'
  | 'degraded'
  | 'run-failed'
  | 'taken-over'
  | 'error'
  | 'unreachable'
  | 'loading';

/** Used by createForemanApi to validate the `scenario` query parameter and by the mock client's tests. */
export const MOCK_SCENARIOS: MockScenario[] = [
  'default',
  'empty',
  'quiet',
  'budget-paused',
  'plan-window-paused',
  'deepseek-unread',
  'degraded',
  'run-failed',
  'taken-over',
  'error',
  'unreachable',
  'loading',
];

// Every mode the contract names, so a mode added to it shows up in this scenario; the ones that have a reason carry one, as Foreman's do.
const DEGRADED_REASONS: Partial<Record<DegradedMode, string>> = { infigraph: 'desk: the code graph could not be built (the index file is missing)' };

const nextMonthStart = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

const failRun = (store: MockStore): void => {
  const run = store.runs.find((candidate) => candidate.id === 'run-t2');
  if (!run) return;
  run.state = 'stopped';
  run.failure = RUN_FAILURE;
  run.stages = run.stages.map((stage) => (stage.id === 'worker' ? { ...stage, state: 'failed' } : stage));
};

/** Used by the mock client to bend the sample data into one of the special states of wireframes §15 (the error and loading scenarios are handled by the client). */
export function applyScenario(store: MockStore, scenario: MockScenario, now: number): void {
  if (scenario === 'empty') {
    Object.assign(store, { goals: [], questions: [], review: [], history: [], runs: [], threads: {}, alerts: [] });
    store.today = { briefing: null, trend: [], running: [] };
  } else if (scenario === 'quiet') {
    store.questions = [];
    for (const goal of store.goals) {
      goal.waitsOnYou = { decisions: 0, rowsHeld: 0 };
      for (const batch of goal.batches) {
        if (batch.state === 'waiting') Object.assign(batch, { state: 'queued', waitsOn: null });
      }
    }
    store.today.briefing?.sentences.splice(2, 1, 'Nothing needs you; everything is moving.');
  } else if (scenario === 'budget-paused') {
    store.questions = [ceilingQuestion(now), ...store.questions];
    store.status = {
      ...store.status,
      state: 'paused',
      pauseReason: 'api-ceiling',
      resumesAt: at(nextMonthStart(now), 0),
      spend: { ...store.status.spend, monthUsd: 200, paceUsdPerDay: 0 },
    };
  } else if (scenario === 'plan-window-paused') {
    // What an older or differently routed Foreman could still send: the strip must name no gauge and no percentage for it.
    store.status = {
      ...store.status,
      state: 'workers-paused',
      pauseReason: 'minimax-window',
      resumesAt: at(now, 2 * HOUR_MS),
      minimax: { fiveHourPct: 80, weeklyPct: 31 },
    };
  } else if (scenario === 'deepseek-unread') {
    store.status = { ...store.status, spend: { ...store.status.spend, deepseekMonthUsd: null } };
  } else if (scenario === 'degraded') {
    store.status.degraded = DEGRADED_MODES.map((mode, position) => {
      const reason = DEGRADED_REASONS[mode];
      return { mode, since: at(now, -(position + 1) * HOUR_MS), ...(reason === undefined ? {} : { reason }) };
    });
  } else if (scenario === 'run-failed') {
    failRun(store);
  } else if (scenario === 'taken-over') {
    for (const run of store.runs) if (run.id === 'run-t2') run.control = 'owner';
  }
}

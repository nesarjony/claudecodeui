import type { GoalSummary, RunSummary } from '@/modules/foreman-next/api/contract';

export const BOARD_COLUMN_IDS = ['waiting', 'active', 'queued', 'done'] as const;
export type BoardColumnId = (typeof BOARD_COLUMN_IDS)[number];

type BoardColumns = {
  waiting: GoalSummary[];
  active: GoalSummary[];
  queued: GoalSummary[];
  done: GoalSummary[];
  handedOver: RunSummary[];
};

/** Splits goals into the board's columns. A goal is in "Waiting on you" whenever a decision holds it, and also in its own column, so an active goal can sit in two. */
export function boardColumns(goals: GoalSummary[], handedOver: RunSummary[]): BoardColumns {
  return {
    waiting: goals.filter((goal) => goal.state !== 'done' && goal.waitsOnYou.decisions > 0),
    active: goals.filter((goal) => goal.state === 'studying' || goal.state === 'active' || goal.state === 'paused'),
    queued: goals.filter((goal) => goal.state === 'queued'),
    done: goals.filter((goal) => goal.state === 'done'),
    handedOver,
  };
}

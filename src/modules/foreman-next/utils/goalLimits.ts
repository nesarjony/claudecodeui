import type { GoalBudget, GoalDetail, IsoTime } from '@/modules/foreman-next/api/contract';

/** What the owner typed into a limit field: nothing, a value Foreman can be given, or something it cannot, with the catalog key (`work.limits.error.*`) that says why. */
export type Typed<T> = { kind: 'none' } | { kind: 'ok'; value: T } | { kind: 'invalid'; reason: 'notAmount' | 'notDate' | 'past' };

const AMOUNT = /^\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A budget in dollars as typed ("60", "12.50", "$60"): blank is none, a positive finite amount is ok, and anything else (zero, a minus, "1e3", words) is not an amount. */
export function parseBudgetInput(text: string): Typed<number> {
  const plain = text.trim().replace(/^\$/, '').trim();
  if (plain === '') return { kind: 'none' };
  const amount = AMOUNT.test(plain) ? Number(plain) : Number.NaN;
  return Number.isFinite(amount) && amount > 0 ? { kind: 'ok', value: amount } : { kind: 'invalid', reason: 'notAmount' };
}

/** A deadline from a date field ("2026-12-01"), which Foreman is given as the end of that day in the owner's time zone: it must be a real date and not already passed. */
export function parseDeadlineInput(text: string, now: Date): Typed<IsoTime> {
  const plain = text.trim();
  if (plain === '') return { kind: 'none' };
  const match = DATE.exec(plain);
  if (!match) return { kind: 'invalid', reason: 'notDate' };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  // A day that does not exist (31 February) rolls over into the next month in `Date`: it is not the day that was typed.
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) return { kind: 'invalid', reason: 'notDate' };
  return end.getTime() > now.getTime() ? { kind: 'ok', value: end.toISOString() } : { kind: 'invalid', reason: 'past' };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A moment as the value of a date field: the owner's own calendar day, "2026-12-01". */
export function dateInputOf(time: IsoTime | Date): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The goal's limits, or `null` from a Foreman that does not send them yet: nothing about limits is shown for such a goal, and nothing is asked of a route it may not have. */
export function budgetOf(goal: GoalDetail): GoalBudget | null {
  const { budget } = goal as { budget?: GoalBudget | null };
  return budget ?? null;
}

/** Whether the goal has used up the budget the owner gave it, which holds it until he raises or removes the budget (a done goal is past holding). */
export function heldForBudget(goal: Pick<GoalDetail, 'state' | 'spentUsd'> & { budget?: GoalBudget | null }): boolean {
  const limit = goal.budget?.limitUsd ?? null;
  return goal.state !== 'done' && limit !== null && goal.spentUsd >= limit;
}

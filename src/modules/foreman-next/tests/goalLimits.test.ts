import { describe, expect, it } from 'vitest';

import type { GoalBudget } from '@/modules/foreman-next/api/contract';
import { budgetOf, dateInputOf, heldForBudget, parseBudgetInput, parseDeadlineInput } from '@/modules/foreman-next/utils/goalLimits';
import { quickApi } from '@/modules/foreman-next/tests/testHelpers';

describe('a budget as typed', () => {
  it('is none when blank, and an amount when positive, with or without a dollar sign', () => {
    expect(parseBudgetInput('')).toEqual({ kind: 'none' });
    expect(parseBudgetInput('   ')).toEqual({ kind: 'none' });
    expect(parseBudgetInput('60')).toEqual({ kind: 'ok', value: 60 });
    expect(parseBudgetInput(' 12.50 ')).toEqual({ kind: 'ok', value: 12.5 });
    expect(parseBudgetInput('$60')).toEqual({ kind: 'ok', value: 60 });
    expect(parseBudgetInput('0.01')).toEqual({ kind: 'ok', value: 0.01 });
  });

  it('is not an amount when it is zero, negative, a word, or a number written another way', () => {
    for (const text of ['0', '0.00', '-5', 'abc', '1e3', '0x10', 'Infinity', 'NaN', '12,5', '1 000', '60$', '.5', '5.']) {
      expect(parseBudgetInput(text), text).toEqual({ kind: 'invalid', reason: 'notAmount' });
    }
  });
});

describe('a deadline as typed', () => {
  const now = new Date(2026, 10, 18, 15, 30);

  it('is none when blank, and the end of that day in the owner\'s time zone when it has not passed', () => {
    expect(parseDeadlineInput('', now)).toEqual({ kind: 'none' });
    expect(parseDeadlineInput('2026-12-01', now)).toEqual({ kind: 'ok', value: new Date(2026, 11, 1, 23, 59, 59, 999).toISOString() });
  });

  it('allows today, which has hours left, and refuses a day that has passed', () => {
    expect(parseDeadlineInput('2026-11-18', now).kind).toBe('ok');
    expect(parseDeadlineInput('2026-11-17', now)).toEqual({ kind: 'invalid', reason: 'past' });
    expect(parseDeadlineInput('2020-01-01', now)).toEqual({ kind: 'invalid', reason: 'past' });
  });

  it('refuses what is not a date, including a day that does not exist', () => {
    for (const text of ['tomorrow', '2026-13-01', '2026-02-31', '12/01/2026', '2026-1-5']) {
      expect(parseDeadlineInput(text, now), text).toEqual({ kind: 'invalid', reason: 'notDate' });
    }
  });

  it('fills a date field with the owner\'s own calendar day of a moment', () => {
    expect(dateInputOf(new Date(2026, 11, 1, 23, 59, 59, 999))).toBe('2026-12-01');
    expect(dateInputOf(new Date(2026, 0, 5, 0, 0, 1).toISOString())).toBe('2026-01-05');
  });
});

describe('the limits of a goal', () => {
  it('are none from a Foreman that does not send them, and what Foreman sends otherwise', async () => {
    const goal = await quickApi().goal('g-inbox');
    const { budget: sent } = goal;
    expect(budgetOf(goal)).toEqual(sent);
    expect(budgetOf({ ...goal, budget: undefined } as unknown as typeof goal)).toBeNull();
    expect(budgetOf({ ...goal, budget: null } as unknown as typeof goal)).toBeNull();
  });

  it('hold a goal that has spent its budget, and not one with no budget, room left, or nothing more to hold', () => {
    const budget = (limitUsd: number | null): GoalBudget => ({ limitUsd, deadline: null, projectedUsd: null, fits: null, onTime: null });
    expect(heldForBudget({ state: 'paused', spentUsd: 12.4, budget: budget(12) })).toBe(true);
    expect(heldForBudget({ state: 'paused', spentUsd: 12, budget: budget(12) })).toBe(true);
    expect(heldForBudget({ state: 'paused', spentUsd: 11.99, budget: budget(12) })).toBe(false);
    expect(heldForBudget({ state: 'paused', spentUsd: 500, budget: budget(null) })).toBe(false);
    expect(heldForBudget({ state: 'paused', spentUsd: 500 })).toBe(false);
    expect(heldForBudget({ state: 'done', spentUsd: 12.4, budget: budget(12) })).toBe(false);
  });
});

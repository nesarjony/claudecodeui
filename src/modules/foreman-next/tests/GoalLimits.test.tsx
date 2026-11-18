import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { DAY_MS } from '@/modules/foreman-next/api/mock/time';
import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';
import { formatDay, formatWeekday } from '@/modules/foreman-next/utils/foremanFormat';
import { dateInputOf } from '@/modules/foreman-next/utils/goalLimits';
import { ApiRequestError } from '@/shared/api';

const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const endOfDay = (date: Date): string => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();

const open = async (goalId: string, api: ForemanApi = quickApi()) => {
  renderForemanApp(`/foreman/work/${goalId}`, api);
  return screen.findByRole('region', { name: 'Limits' });
};
const budgetForm = () => within(screen.getByRole('form', { name: 'Set the budget' }));
const deadlineForm = () => within(screen.getByRole('form', { name: 'Set the deadline' }));

describe('the limits of a goal, on its page', () => {
  it('says a goal has no budget and no deadline beyond the Charter, with its success measure still in the header', async () => {
    const panel = await open('g-inbox');
    expect(within(panel).getByText("No budget for this goal beyond the Charter's limits.")).toBeTruthy();
    expect(within(panel).getByText('No deadline.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByText('Done when: all 120 checklist rows are DONE and verified by the judge')).toBeTruthy();
  });

  it('shows the budget with what the goal has cost and the forecast against it, and the deadline with whether the forecast meets it', async () => {
    const api = quickApi();
    const deadline = endOfDay(daysFromNow(10));
    await api.setGoalLimits('g-inbox', { budgetUsd: 40, deadline });
    const panel = await open('g-inbox', api);
    expect(within(panel).getByText('Budget $40 · $12.40 spent so far')).toBeTruthy();
    expect(within(panel).getByText('At the forecast it will cost $23.40 in all, within the budget.')).toBeTruthy();
    expect(within(panel).getByText(`Deadline ${formatWeekday(deadline)} ${formatDay(deadline)}`)).toBeTruthy();
    expect(within(panel).getByText('The forecast finishes by then.')).toBeTruthy();
    expect((within(panel).getByRole('textbox', { name: 'Budget (USD)' }) as HTMLInputElement).value).toBe('40');
  });

  it('says when the forecast is over the budget and past the deadline', async () => {
    const api = quickApi();
    await api.setGoalLimits('g-inbox', { budgetUsd: 15, deadline: endOfDay(daysFromNow(1)) });
    const panel = await open('g-inbox', api);
    expect(within(panel).getByText('At the forecast it will cost $23.40 in all, more than the budget.')).toBeTruthy();
    expect(within(panel).getByText('The forecast finishes after it.')).toBeTruthy();
  });

  it('sets a budget, and the page shows it once saved', async () => {
    const api = quickApi();
    const set = vi.spyOn(api, 'setGoalLimits');
    await open('g-inbox', api);
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (USD)' }), { target: { value: '60' } });
    fireEvent.click(budgetForm().getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set).toHaveBeenCalledWith('g-inbox', { budgetUsd: 60 });
    expect(await screen.findByText('Budget $60 · $12.40 spent so far')).toBeTruthy();
    expect(budgetForm().getByRole('button', { name: 'Remove budget' })).toBeTruthy();
  });

  it('sets a deadline as the end of the day picked, and sends no budget with it', async () => {
    const api = quickApi();
    const set = vi.spyOn(api, 'setGoalLimits');
    await open('g-inbox', api);
    const day = daysFromNow(10);
    fireEvent.change(screen.getByLabelText('Deadline', { selector: 'input' }), { target: { value: dateInputOf(day) } });
    fireEvent.click(deadlineForm().getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set).toHaveBeenCalledWith('g-inbox', { deadline: endOfDay(day) });
    expect(await screen.findByText(`Deadline ${formatWeekday(endOfDay(day))} ${formatDay(endOfDay(day))}`)).toBeTruthy();
  });

  it('refuses a budget that is not an amount above zero before it asks Foreman, and says why', async () => {
    const api = quickApi();
    const set = vi.spyOn(api, 'setGoalLimits');
    await open('g-inbox', api);
    const field = screen.getByRole('textbox', { name: 'Budget (USD)' });
    for (const text of ['0', '-5', 'lots']) {
      fireEvent.change(field, { target: { value: text } });
      expect(await screen.findByText('Enter an amount above zero, like 60 or 12.50.')).toBeTruthy();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect((budgetForm().getByRole('button', { name: 'Set' }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.submit(screen.getByRole('form', { name: 'Set the budget' }));
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses a deadline that is a day gone before it asks Foreman, and says why', async () => {
    const api = quickApi();
    const set = vi.spyOn(api, 'setGoalLimits');
    await open('g-inbox', api);
    fireEvent.change(screen.getByLabelText('Deadline', { selector: 'input' }), { target: { value: dateInputOf(daysFromNow(-1)) } });
    expect(await screen.findByText('Pick a day that has not passed.')).toBeTruthy();
    expect((deadlineForm().getByRole('button', { name: 'Set' }) as HTMLButtonElement).disabled).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('removes a budget and a deadline by sending null for that one limit', async () => {
    const api = quickApi();
    await api.setGoalLimits('g-inbox', { budgetUsd: 40, deadline: endOfDay(daysFromNow(10)) });
    const set = vi.spyOn(api, 'setGoalLimits');
    await open('g-inbox', api);
    fireEvent.click(budgetForm().getByRole('button', { name: 'Remove budget' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('g-inbox', { budgetUsd: null }));
    expect(await screen.findByText("No budget for this goal beyond the Charter's limits.")).toBeTruthy();
    fireEvent.click(deadlineForm().getByRole('button', { name: 'Remove deadline' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('g-inbox', { deadline: null }));
    expect(await screen.findByText('No deadline.')).toBeTruthy();
    expect(set).toHaveBeenCalledTimes(2);
  });
});

describe('a goal held for its budget', () => {
  it('says so, offers to raise the budget, and goes on once the budget is raised above what it has cost', async () => {
    const api = quickApi('goal-over-budget');
    const set = vi.spyOn(api, 'setGoalLimits');
    const panel = await open('g-inbox', api);
    expect(within(panel).getByRole('status').textContent).toBe('This goal has used up its budget of $12 ($12.40 spent), so it is held. Raise the budget above what it has cost for it to go on.');
    expect(screen.getByText('paused')).toBeTruthy();
    const raise = budgetForm().getByRole('button', { name: 'Raise budget' }) as HTMLButtonElement;
    expect(raise.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (USD)' }), { target: { value: '30' } });
    expect(raise.disabled).toBe(false);
    fireEvent.click(raise);
    await waitFor(() => expect(set).toHaveBeenCalledWith('g-inbox', { budgetUsd: 30 }));
    await waitFor(() => expect(screen.queryByText(/has used up its budget/)).toBeNull());
    expect(await screen.findByText('Budget $30 · $12.40 spent so far')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Raise budget' })).toBeNull();
  });

  it('goes on when the budget is removed instead', async () => {
    const api = quickApi('goal-over-budget');
    const panel = await open('g-inbox', api);
    expect(within(panel).getByRole('status')).toBeTruthy();
    fireEvent.click(budgetForm().getByRole('button', { name: 'Remove budget' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('does not say it is held while there is room in the budget', async () => {
    const api = quickApi();
    await api.setGoalLimits('g-inbox', { budgetUsd: 40 });
    await open('g-inbox', api);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Raise budget' })).toBeNull();
  });
});

describe('when Foreman does not take the change', () => {
  it('shows what Foreman refused for, as it said it, and keeps the page', async () => {
    const api = quickApi();
    vi.spyOn(api, 'setGoalLimits').mockRejectedValue(new ApiRequestError('the deadline has already passed', { code: 'invalid', status: 400 }));
    await open('g-inbox', api);
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (USD)' }), { target: { value: '60' } });
    fireEvent.click(budgetForm().getByRole('button', { name: 'Set' }));
    expect((await screen.findByRole('alert')).textContent).toBe('the deadline has already passed');
    expect(screen.getByRole('region', { name: 'Limits' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'desk · Inbox at 100% Libredesk parity' })).toBeTruthy();
  });

  it('says Foreman may still be updating when it has no such route yet (a 404), and the page does not break', async () => {
    const api = quickApi();
    vi.spyOn(api, 'setGoalLimits').mockRejectedValue(new ApiRequestError('Not found.', { code: 'NOT_FOUND', status: 404 }));
    await open('g-inbox', api);
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (USD)' }), { target: { value: '60' } });
    fireEvent.click(budgetForm().getByRole('button', { name: 'Set' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Foreman cannot change limits right now (it may still be updating). Try again in a minute.');
    expect(screen.getByRole('region', { name: 'Limits' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Budget (USD)' }) as HTMLInputElement).value).toBe('60');
    expect(document.body.textContent).not.toMatch(/Not found|undefined/);
  });

  it('shows no limits at all, and no control, for a Foreman that sends none yet, and the rest of the page is as before', async () => {
    const api = quickApi();
    const goal = await api.goal('g-inbox');
    vi.spyOn(api, 'goal').mockResolvedValue({ ...goal, budget: undefined } as unknown as typeof goal);
    renderForemanApp('/foreman/work/g-inbox', api);
    expect(await screen.findByRole('heading', { name: 'desk · Inbox at 100% Libredesk parity' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Progress' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Limits' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Set the budget' })).toBeNull();
  });

  it('shows a finished goal\'s limits without controls, which Foreman would refuse', async () => {
    const api = quickApi();
    const panel = await open('g-demo', api);
    expect(within(panel).getByText("No budget for this goal beyond the Charter's limits.")).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Set the budget' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Set the deadline' })).toBeNull();
  });
});

describe('the mock, as Foreman answers a change of limits', () => {
  it('refuses a goal that is done, a budget that is no amount, a deadline that has passed, and a goal it does not have', async () => {
    const api = quickApi();
    await expect(api.setGoalLimits('g-demo', { budgetUsd: 10 })).rejects.toMatchObject({ status: 409 });
    await expect(api.setGoalLimits('g-inbox', { budgetUsd: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(api.setGoalLimits('g-inbox', { budgetUsd: Number.NaN })).rejects.toMatchObject({ status: 400 });
    await expect(api.setGoalLimits('g-inbox', { deadline: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ status: 400 });
    await expect(api.setGoalLimits('g-nothing', { budgetUsd: 10 })).rejects.toMatchObject({ status: 404 });
  });

  it('leaves a field that is left out as it was, and takes a limit away with null', async () => {
    const api = quickApi();
    const deadline = endOfDay(daysFromNow(5));
    await api.setGoalLimits('g-inbox', { budgetUsd: 40, deadline });
    const budgetOnly = await api.setGoalLimits('g-inbox', { budgetUsd: 50 });
    expect(budgetOnly.budget).toMatchObject({ limitUsd: 50, deadline });
    const withoutDeadline = await api.setGoalLimits('g-inbox', { deadline: null });
    expect(withoutDeadline.budget).toMatchObject({ limitUsd: 50, deadline: null, onTime: null });
    const withoutBudget = await api.setGoalLimits('g-inbox', { budgetUsd: null });
    expect(withoutBudget.budget).toEqual({ limitUsd: null, deadline: null, projectedUsd: null, fits: null, onTime: null });
  });
});

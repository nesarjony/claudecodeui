import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

const openDialog = async (api = quickApi()) => {
  renderForemanApp('/foreman/work', api);
  fireEvent.click(await screen.findByRole('button', { name: '+ New goal' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByLabelText('Repo');
  fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Reports' } });
  return dialog;
};

describe('the new goal form, with its two optional limits', () => {
  it('asks only for the repo and the goal by default, and sends just those when the optional fields stay empty', async () => {
    const api = quickApi();
    const create = vi.spyOn(api, 'createGoal');
    const dialog = await openDialog(api);
    expect((within(dialog).getByLabelText('Success measure (optional)') as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText('Budget in USD (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toStrictEqual({ repo: 'desk', goal: 'Reports' });
  });

  it('sends the success measure and the budget when they are filled in, trimmed and as a number', async () => {
    const api = quickApi();
    const create = vi.spyOn(api, 'createGoal');
    const dialog = await openDialog(api);
    fireEvent.change(within(dialog).getByLabelText('Success measure (optional)'), { target: { value: '  all 40 report rows are DONE  ' } });
    fireEvent.change(within(dialog).getByLabelText('Budget in USD (optional)'), { target: { value: '$60' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toStrictEqual({ repo: 'desk', goal: 'Reports', successMeasure: 'all 40 report rows are DONE', budgetUsd: 60 });
  });

  it('sends only the success measure when there is no budget', async () => {
    const api = quickApi();
    const create = vi.spyOn(api, 'createGoal');
    const dialog = await openDialog(api);
    fireEvent.change(within(dialog).getByLabelText('Success measure (optional)'), { target: { value: 'the report screens match desk' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toStrictEqual({ repo: 'desk', goal: 'Reports', successMeasure: 'the report screens match desk' });
  });

  it('sends only the budget when the success measure is blank or spaces', async () => {
    const api = quickApi();
    const create = vi.spyOn(api, 'createGoal');
    const dialog = await openDialog(api);
    fireEvent.change(within(dialog).getByLabelText('Success measure (optional)'), { target: { value: '   ' } });
    fireEvent.change(within(dialog).getByLabelText('Budget in USD (optional)'), { target: { value: '12.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toStrictEqual({ repo: 'desk', goal: 'Reports', budgetUsd: 12.5 });
  });

  it('does not create the goal while the budget is not an amount above zero, and says why', async () => {
    const api = quickApi();
    const create = vi.spyOn(api, 'createGoal');
    const dialog = await openDialog(api);
    const budget = within(dialog).getByLabelText('Budget in USD (optional)');
    for (const text of ['0', '-3', 'ten']) {
      fireEvent.change(budget, { target: { value: text } });
      expect(within(dialog).getByText('Enter an amount above zero, like 60 or 12.50.')).toBeTruthy();
      expect(budget.getAttribute('aria-invalid')).toBe('true');
      expect((within(dialog).getByRole('button', { name: 'Create goal' }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(budget, { target: { value: '' } });
    expect((within(dialog).getByRole('button', { name: 'Create goal' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lands on the new goal\'s page with the measure it was given as "Done when" and the budget in its limits', async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Success measure (optional)'), { target: { value: 'the report screens match desk' } });
    fireEvent.change(within(dialog).getByLabelText('Budget in USD (optional)'), { target: { value: '25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    expect(await screen.findByText('Done when: the report screens match desk')).toBeTruthy();
    const limits = await screen.findByRole('region', { name: 'Limits' });
    expect(within(limits).getByText('Budget $25 · $0.00 spent so far')).toBeTruthy();
  });
});

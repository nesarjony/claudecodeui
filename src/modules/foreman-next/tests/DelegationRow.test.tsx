import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DelegationRule } from '@/modules/foreman-next/api/contract';
import { delegationFixture } from '@/modules/foreman-next/api/mock/settingsFixtures';
import { DelegationRow } from '@/modules/foreman-next/settings/DelegationRow';
import { DelegationTable } from '@/modules/foreman-next/settings/DelegationTable';
import { quickApi, readyResource, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const rule = (kind: DelegationRule['kind']): DelegationRule => {
  const found = delegationFixture().find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};

const row = (target: DelegationRule, api = quickApi()) => {
  renderWithForeman(
    <table>
      <tbody>
        <DelegationRow rule={target} />
      </tbody>
    </table>,
    { api },
  );
  return { api };
};

describe('the trust ladder controls', () => {
  it('shows the level, how often the owner agreed, and the four levels to choose from', () => {
    row(rule('replan-goal'));
    const level = screen.getByLabelText('Level for Re-plan a goal') as HTMLSelectElement;
    expect(level.value).toBe('decide-tell');
    expect(Array.from(level.options).map((option) => option.textContent)).toEqual(['Ask me', 'Recommend and wait', 'Decide, tell me', 'Decide silently']);
    expect(screen.getByText('9 of 9')).toBeTruthy();
    expect((screen.getByLabelText('Veto window for Re-plan a goal') as HTMLSelectElement).value).toBe('6');
  });

  it('moves a kind up a level and clears the veto window for levels that have none', async () => {
    const { api } = row(rule('replan-goal'));
    const set = vi.spyOn(api, 'setDelegation');
    fireEvent.change(screen.getByLabelText('Level for Re-plan a goal'), { target: { value: 'decide-silent' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('replan-goal', { level: 'decide-silent', vetoWindowHours: null }));
  });

  it('gives "Decide, tell me" a default veto window of 6 hours, and lets the owner change it', async () => {
    const { api } = row(rule('budget-share'));
    const set = vi.spyOn(api, 'setDelegation');
    fireEvent.change(screen.getByLabelText('Level for Raise a goal\'s budget share'), { target: { value: 'decide-tell' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('budget-share', { level: 'decide-tell', vetoWindowHours: 6 }));
  });

  it('changes only the veto window when the owner picks another one', async () => {
    const { api } = row(rule('replan-goal'));
    const set = vi.spyOn(api, 'setDelegation');
    fireEvent.change(screen.getByLabelText('Veto window for Re-plan a goal'), { target: { value: '12' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('replan-goal', { level: 'decide-tell', vetoWindowHours: 12 }));
  });

  it('shows a locked kind as owner only, with nothing to change', () => {
    row(rule('charter'));
    expect(screen.getByText('Owner only (locked)')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('offers Foreman\'s suggestion for the owner to approve, and nothing when there is none', async () => {
    const { api } = row(rule('product-scope'));
    const set = vi.spyOn(api, 'setDelegation');
    expect(screen.getByText('Move to "Recommend and wait"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('product-scope', { level: 'recommend-wait', vetoWindowHours: null }));
  });

  it('has no suggestion and no agreement figure for a kind with no history', () => {
    row(rule('worker-setup'));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('set in the lab phase')).toBeTruthy();
  });

  it('says so when the change does not go through', async () => {
    const api = quickApi();
    vi.spyOn(api, 'setDelegation').mockRejectedValue(new Error('down'));
    row(rule('replan-goal'), api);
    fireEvent.change(screen.getByLabelText('Level for Re-plan a goal'), { target: { value: 'ask' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('loads the whole ladder from Foreman, charter row last and locked', async () => {
    const api = quickApi();
    renderWithForeman(<DelegationTable delegation={readyResource(await api.delegation())} />, { api });
    expect(await screen.findByText('Product scope')).toBeTruthy();
    expect(screen.getAllByRole('combobox', { name: /^Level for/ })).toHaveLength(5);
    expect(screen.getByText('Judge grading, scorecard, safety limits, budgets')).toBeTruthy();
  });
});

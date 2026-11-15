import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { decisionsFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { DecisionRecordCard } from '@/modules/foreman-next/decide/DecisionRecordCard';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const record = () => {
  const [first] = decisionsFixture(Date.now());
  if (!first) throw new Error('fixture is empty');
  return first;
};

describe('the decision card (a decision Foreman made)', () => {
  it('shows what Foreman saw, used, considered and chose, the outcome, the cost and the trace', () => {
    renderWithForeman(<DecisionRecordCard record={record()} />);
    const card = screen.getByRole('article', { name: 'Steer at turn 9 · t2-layout' });
    expect(within(card).getByText(/supervisor v2 on Opus · \$0\.04 · 3\.1s/)).toBeTruthy();
    expect(within(card).getByText('Saw').nextElementSibling?.textContent).toMatch(/second fetch in InboxLayout/);
    expect(within(card).getByText('Used').nextElementSibling?.textContent).toMatch(/one data source per list/);
    expect(within(card).getByText('Considered').nextElementSibling?.textContent).toMatch(/continue.*steer.*ask you/);
    expect(within(card).getByText('Chose').nextElementSibling?.textContent).toMatch(/^steer:/);
    expect(within(card).getByText('Outcome').nextElementSibling?.textContent).toMatch(/Row 7 passed/);
    expect(within(card).getByRole('link', { name: /Trace/ }).getAttribute('href')).toContain('/traces/');
  });

  it('records Good in one tap', async () => {
    const api = quickApi();
    const rate = vi.spyOn(api, 'rateDecision');
    renderWithForeman(<DecisionRecordCard record={record()} />, { api });
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    await waitFor(() => expect(rate).toHaveBeenCalledWith('dec-steer-9', { verdict: 'good' }));
  });

  it('asks what it should have done for Bad, and sends the correction that becomes a test case', async () => {
    const api = quickApi();
    const rate = vi.spyOn(api, 'rateDecision');
    renderWithForeman(<DecisionRecordCard record={record()} />, { api });
    expect(screen.queryByLabelText('What should it have done?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bad' }));
    fireEvent.change(screen.getByLabelText('What should it have done?'), { target: { value: 'Ask me first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rate).toHaveBeenCalled());
    expect(rate).toHaveBeenCalledWith('dec-steer-9', { verdict: 'bad', correction: 'Ask me first' });
    expect(screen.getByText(/A Bad with a correction becomes a test case/)).toBeTruthy();
  });

  it('shows a saved correction as the test case it became', () => {
    renderWithForeman(<DecisionRecordCard record={{ ...record(), feedback: { verdict: 'bad', correction: 'Ask me first' } }} />);
    expect(screen.getByText(/Your correction is now a test case: "Ask me first"/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bad' }).getAttribute('aria-pressed')).toBe('true');
  });
});

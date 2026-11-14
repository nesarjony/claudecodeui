import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { reviewFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { ReviewRow } from '@/modules/foreman-next/decide/ReviewRow';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const item = () => {
  const [first] = reviewFixture(Date.now());
  if (!first) throw new Error('fixture is empty');
  return first;
};

const inList = (api = quickApi(), onSettled = vi.fn()) => {
  renderWithForeman(
    <ul>
      <ReviewRow item={item()} onSettled={onSettled} />
    </ul>,
    { api },
  );
  return { api, onSettled };
};

describe('a Review row', () => {
  it('shows the item, its evidence and its veto window', () => {
    inList();
    expect(screen.getByText('Adopted rule hooks/state-reset in desk')).toBeTruthy();
    expect(screen.getByText('E7 · +18 points over 12 rows')).toBeTruthy();
    expect(screen.getByText(/^closes \d{2}:\d{2} · in 3h 1\dm$/)).toBeTruthy();
  });

  it('closes the item early with OK', async () => {
    const { api, onSettled } = inList();
    const acknowledge = vi.spyOn(api, 'acknowledgeReviewItem');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(acknowledge).toHaveBeenCalledWith('r-rule');
  });

  it('will not veto without a reason, then vetoes and records why', async () => {
    const { api, onSettled } = inList();
    const veto = vi.spyOn(api, 'vetoReviewItem');
    fireEvent.click(screen.getByRole('button', { name: 'Veto' }));
    const confirm = screen.getByRole('button', { name: 'Veto and record why' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why are you vetoing this?'), { target: { value: 'the rule is too broad' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(veto).toHaveBeenCalledWith('r-rule', 'the rule is too broad');
  });

  it('shows the change itself under Details', () => {
    inList();
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/reset local state when the entity id changes/)).toBeTruthy();
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { reviewFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { ReviewRow } from '@/modules/foreman-next/decide/ReviewRow';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const item = () => {
  const [first] = reviewFixture(Date.now());
  if (!first) throw new Error('fixture is empty');
  return first;
};

const ofKind = (kind: ReviewItem['kind']): ReviewItem => {
  const found = reviewFixture(Date.now()).find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`no ${kind} item`);
  return found;
};

const inList = (api = quickApi(), target = item()) => {
  renderWithForeman(
    <ul>
      <ReviewRow item={target} />
    </ul>,
    { api },
  );
  return { api };
};

describe('a Review row', () => {
  it('shows the item, its evidence and its veto window', () => {
    inList();
    expect(screen.getByText('Adopted rule hooks/state-reset in desk')).toBeTruthy();
    expect(screen.getByText('E7 · +18 points over 12 rows')).toBeTruthy();
    expect(screen.getByText(/^closes \d{2}:\d{2} · in 3h 1\dm$/)).toBeTruthy();
  });

  it('closes the item early with OK', async () => {
    const { api } = inList(quickApi(), ofKind('delegated-decision'));
    const acknowledge = vi.spyOn(api, 'acknowledgeReviewItem');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('r-retry'));
  });

  it.each(['rule', 'lesson'] as const)('lets the owner OK a %s only while its whole text is shown, and says why until then', async (kind) => {
    const target = ofKind(kind);
    const { api } = inList(quickApi(), target);
    const acknowledge = vi.spyOn(api, 'acknowledgeReviewItem');
    const ok = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(screen.getByText(/Open Details and read all of it first/)).toBeTruthy();
    fireEvent.click(ok);
    expect(acknowledge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(target.detail)).toBeTruthy();
    expect(ok.disabled).toBe(false);
    expect(screen.queryByText(/Open Details and read all of it first/)).toBeNull();

    // Hiding the text locks it again: the button follows what is on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(ok.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(ok);
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(target.id));
  });

  it('opens with its text shown, and OK ready, when a link named it', () => {
    renderWithForeman(
      <ul>
        <ReviewRow item={ofKind('lesson')} startOpen />
      </ul>,
    );
    expect(screen.getByText(ofKind('lesson').detail)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['replan', 'delegated-decision'] as const)('keeps OK ready for a %s, which has no text to read first', (kind) => {
    inList(quickApi(), ofKind(kind));
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('will not veto without a reason, then vetoes and records why', async () => {
    const { api } = inList();
    const veto = vi.spyOn(api, 'vetoReviewItem');
    fireEvent.click(screen.getByRole('button', { name: 'Veto' }));
    const confirm = screen.getByRole('button', { name: 'Veto and record why' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why are you vetoing this?'), { target: { value: 'the rule is too broad' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(veto).toHaveBeenCalledWith('r-rule', 'the rule is too broad'));
  });

  it('opens a re-plan\'s diff on the goal page, by the subject Foreman gave and not by its title', () => {
    inList(quickApi(), ofKind('replan'));
    expect(screen.getByRole('link', { name: 'Diff' }).getAttribute('href')).toBe('/foreman/work/g-inbox?compare=previous');
  });

  it('opens the decision card of something Foreman decided alone', () => {
    inList(quickApi(), ofKind('delegated-decision'));
    expect(screen.getByRole('link', { name: 'Card' }).getAttribute('href')).toBe('/foreman/decisions/h-retry-1');
  });

  it('has nothing to open for a rule or a lesson, which have no page yet', () => {
    inList();
    expect(screen.queryByRole('link')).toBeNull();
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

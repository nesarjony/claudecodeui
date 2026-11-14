import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

describe('Decide', () => {
  it('opens on Needs you with a card for each blocking decision', async () => {
    renderForemanApp('/foreman/decide');
    expect(await screen.findByRole('article', { name: 'Bulk actions in v1?' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Realtime transport' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Decide sections' });
    expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Needs you (2)', 'Review', 'History']);
  });

  it('shows only the decision a link points at, with a way back to all of them', async () => {
    renderForemanApp('/foreman/decide/needs/q-realtime');
    expect(await screen.findByRole('article', { name: 'Realtime transport' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Bulk actions in v1?' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /All decisions/ }));
    expect(await screen.findByRole('article', { name: 'Bulk actions in v1?' })).toBeTruthy();
  });

  it('removes an answered decision, lowers the count, and then says nothing needs the owner and what Foreman is doing', async () => {
    renderForemanApp('/foreman/decide');
    for (const title of ['Bulk actions in v1?', 'Realtime transport']) {
      const card = await screen.findByRole('article', { name: title });
      fireEvent.click(within(card).getAllByRole('button', { name: /^[A-C]:/ })[0] as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('article', { name: title })).toBeNull());
    }
    expect(await screen.findByText('Nothing needs you.')).toBeTruthy();
    expect(await screen.findByText('Foreman is working on t2-layout.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(/decisions? need/)).toBeNull());
  });

  it('says nothing needs the owner in the quiet scenario', async () => {
    renderForemanApp('/foreman/decide', quickApi('quiet'));
    expect(await screen.findByText('Nothing needs you.')).toBeTruthy();
    expect(await screen.findByText('Foreman is working on t2-layout.')).toBeTruthy();
  });

  it('lists Review with the evidence and veto windows, and removes a vetoed item', async () => {
    renderForemanApp('/foreman/decide/review');
    expect(await screen.findByText(/Foreman decided these alone/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Veto' })).toHaveLength(4);
    fireEvent.click(screen.getAllByRole('button', { name: 'Veto' })[2] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Why are you vetoing this?'), { target: { value: 'wait for the owner call' } });
    fireEvent.click(screen.getByRole('button', { name: 'Veto and record why' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Veto' })).toHaveLength(3));
    expect(screen.queryByText('Re-planned desk · Inbox (strategy v2)')).toBeNull();
  });

  it('lists History and opens a decision card from it', async () => {
    renderForemanApp('/foreman/decide/history');
    expect(await screen.findByText('Which languages ship in v1?')).toBeTruthy();
    expect(screen.getAllByText('you agreed').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('link', { name: 'Steer at turn 9 · t2-layout' }));
    expect(await screen.findByRole('article', { name: 'Steer at turn 9 · t2-layout' })).toBeTruthy();
  });

  it('goes back to the run when the card belongs to one, and to History otherwise', async () => {
    const { unmount } = renderForemanApp('/foreman/decisions/dec-steer-9');
    expect((await screen.findByRole('link', { name: /◂ Run/ })).getAttribute('href')).toBe('/foreman/work/runs/run-t2');
    unmount();
    renderForemanApp('/foreman/decisions/h-export');
    expect((await screen.findByRole('link', { name: /◂ History/ })).getAttribute('href')).toBe('/foreman/decide/history');
  });

  it('shows no trust-ladder step for a question the owner can never delegate, but names why it is theirs', async () => {
    renderForemanApp('/foreman/decide', quickApi('budget-paused'));
    const ceiling = await screen.findByRole('article', { name: 'Raise the monthly API ceiling?' });
    expect(within(ceiling).getByText(/charter questions are set to "Ask me"/)).toBeTruthy();
    expect(within(ceiling).queryByLabelText(/Let Foreman decide/)).toBeNull();
    const bulk = screen.getByRole('article', { name: 'Bulk actions in v1?' });
    expect(within(bulk).getByLabelText(/Let Foreman decide product scope questions/)).toBeTruthy();
  });

  it('shows the kind of each decision Foreman classified, in History and on the card', async () => {
    renderForemanApp('/foreman/decide/history');
    expect((await screen.findAllByText('Product scope')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Retry or re-plan a batch').length).toBeGreaterThan(0);
  });

  it('says a decision is missing instead of showing an empty card', async () => {
    renderForemanApp('/foreman/decisions/nope');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});


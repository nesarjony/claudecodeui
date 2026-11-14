import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

describe('the shell', () => {
  it('navigates Today, Decide, Work and Settings, with the blocking count, and nothing for later slices', async () => {
    renderForemanApp('/foreman');
    const nav = await screen.findByRole('navigation', { name: 'Foreman' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Today', 'Decide2', 'Work', 'Settings', '◂ Workspace', 'Studio ↗']);
    expect(await within(nav).findByLabelText('2 decisions need you')).toBeTruthy();
    expect(within(nav).queryByText('Knowledge')).toBeNull();
    expect(within(nav).queryByText('Lab')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  });

  it('links the alert count to the list of alerts, which opens what each is about', async () => {
    renderForemanApp('/foreman');
    fireEvent.click(await screen.findByRole('link', { name: '! 1 alert' }));
    expect(await screen.findByRole('heading', { name: 'Alerts' })).toBeTruthy();
    expect(screen.getByText('t2-layout went 9 turns without a commit')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open run/ }).getAttribute('href')).toBe('/foreman/work/runs/run-t2');
  });

  it('shows no alert link and an empty list when nothing is wrong', async () => {
    renderForemanApp('/foreman/alerts', quickApi('empty'));
    expect(await screen.findByText('No alerts.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /alert/ })).toBeNull();
  });

  it('links back to the workspace', async () => {
    renderForemanApp('/foreman');
    expect((await screen.findByRole('link', { name: /Workspace/ })).getAttribute('href')).toBe('/');
  });

  it('links to Studio when Foreman gives its address', async () => {
    renderForemanApp('/foreman');
    expect((await screen.findByRole('link', { name: /Studio/ })).getAttribute('href')).toBe('http://127.0.0.1:4111');
  });

  it('sends an unknown address back to Today', async () => {
    renderForemanApp('/foreman/nowhere');
    expect(await screen.findByText('Needs you · blocking')).toBeTruthy();
  });
});


describe('Today', () => {
  it('opens with the briefing: four sentences, then what needs the owner', async () => {
    renderForemanApp('/foreman');
    expect(await screen.findByRole('region', { name: /^Good (morning|afternoon|evening)$/ })).toBeTruthy();
    expect(screen.getByText(/Since you left at 22:10, Foreman finished 3 batches/)).toBeTruthy();
    expect(screen.getByText(/Inbox is on track: about 9 more batches/)).toBeTruthy();
  });

  it('lists the blocking decisions by rows held, the review items with their veto windows, and the goals', async () => {
    renderForemanApp('/foreman');
    const needs = await screen.findByRole('region', { name: 'Needs you · blocking' });
    expect(await within(needs).findByText('Bulk actions in v1?')).toBeTruthy();
    expect(within(needs).getAllByText(/holds \d+ rows · 2h/).map((row) => row.textContent)).toEqual(['holds 20 rows · 2h', 'holds 15 rows · 2h']);
    const review = screen.getByRole('region', { name: /^Review/ });
    expect(await within(review).findAllByRole('button', { name: 'Looks right' })).toHaveLength(4);
    expect(within(review).getAllByText(/^closes \d{2}:\d{2} · in /)).toHaveLength(4);
    expect(within(review).getByRole('link', { name: 'Diff' }).getAttribute('href')).toBe('/foreman/work/g-inbox?compare=previous');
    expect(within(review).getByRole('link', { name: 'Card' }).getAttribute('href')).toBe('/foreman/decisions/h-retry-1');
    const goals = screen.getByRole('region', { name: 'Goals' });
    expect(within(goals).getByText('65/120')).toBeTruthy();
    expect(within(goals).getByText(/● on track · ~\w{3} · \$11 to go/)).toBeTruthy();
    expect(within(goals).getByText('2 wait on you')).toBeTruthy();
    expect(within(goals).getByText(/○ queued after Inbox/)).toBeTruthy();
  });

  it('shows what runs now, the stuck warning, a handed-over session, and this week\'s trend', async () => {
    renderForemanApp('/foreman');
    const running = await screen.findByRole('region', { name: 'Running now' });
    expect(await within(running).findByText('worker · turn 14 · 23m')).toBeTruthy();
    expect(within(running).getByText('! 9 turns without a commit')).toBeTruthy();
    expect(within(running).getByText('grading 6 rows · 2m')).toBeTruthy();
    expect(within(running).getByText('handed over')).toBeTruthy();
    const week = screen.getByRole('region', { name: 'This week' });
    expect(within(week).getByText('84% → 91%')).toBeTruthy();
    expect(within(week).getByText('$0.46 → $0.38')).toBeTruthy();
    expect(within(week).getByText('11 of 12 calls')).toBeTruthy();
  });

  it('acknowledges a review item in one tap and drops it', async () => {
    const api = quickApi();
    renderForemanApp('/foreman', api);
    const review = await screen.findByRole('region', { name: /^Review/ });
    fireEvent.click((await within(review).findAllByRole('button', { name: 'Looks right' }))[0] as HTMLElement);
    await waitFor(() => expect(within(review).getAllByRole('button', { name: 'Looks right' })).toHaveLength(3));
  });

  it('asks the owner to give Foreman a goal when there are none, and opens the New goal flow', async () => {
    renderForemanApp('/foreman', quickApi('empty'));
    expect(await screen.findByText('Give Foreman a goal')).toBeTruthy();
    expect(screen.getByText('For example: take desk Contacts to 100% parity.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New goal' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Repo')).toBeTruthy();
  });
});


describe('the special states', () => {
  it('shows an error with Retry where a screen cannot load, while the rest of the shell stays', async () => {
    renderForemanApp('/foreman/decide/review', quickApi('error'));
    expect(await screen.findByText('Running')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load this.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows a loading state while Foreman has not answered yet', async () => {
    renderForemanApp('/foreman/decide/review', quickApi('loading'));
    const busy = await screen.findAllByRole('status');
    expect(busy.some((element) => element.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(screen.getByText('Connecting to Foreman...')).toBeTruthy();
  });

  it('shows the Foreman-is-down banner on every screen when it is unreachable', async () => {
    renderForemanApp('/foreman/work', quickApi('unreachable'));
    expect((await screen.findAllByRole('alert')).some((alert) => /Foreman isn't responding/.test(alert.textContent ?? ''))).toBe(true);
  });
});

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AlertItem, EntityRef } from '@/modules/foreman-next/api/contract';
import { entityPath } from '@/modules/foreman-next/utils/foremanPaths';
import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

const alert = (id: string, text: string, subject: AlertItem['subject']): AlertItem => ({ id, severity: 'warning', text, at: new Date().toISOString(), subject });

describe('where an alert opens', () => {
  it('opens the goal page for an alert about a goal, and the run page for one about a run', async () => {
    const api = quickApi();
    vi.spyOn(api, 'alerts').mockResolvedValue([
      alert('stall:g-inbox', 'desk · Inbox stalled: nothing integrated for 6 hours', { kind: 'goal', id: 'g-inbox' }),
      alert('al-stuck', 't2-layout went 9 turns without a commit', { kind: 'run', id: 'run-t2' }),
      alert('al-card', 'a decision wants a second look', { kind: 'decision', id: 'dec-steer-9' }),
    ]);
    renderForemanApp('/foreman/alerts', api);
    const rowOf = async (text: string) => (await screen.findByText(text)).closest('li') as HTMLElement;
    expect(within(await rowOf('desk · Inbox stalled: nothing integrated for 6 hours')).getByRole('link', { name: /Open goal/ }).getAttribute('href')).toBe('/foreman/work/g-inbox');
    expect(within(await rowOf('t2-layout went 9 turns without a commit')).getByRole('link', { name: /Open run/ }).getAttribute('href')).toBe('/foreman/work/runs/run-t2');
    expect(within(await rowOf('a decision wants a second look')).getByRole('link', { name: /Open decision card/ }).getAttribute('href')).toBe('/foreman/decisions/dec-steer-9');
  });

  it('shows the goal page, not a missing run, when the owner follows an alert about a goal', async () => {
    const api = quickApi();
    vi.spyOn(api, 'alerts').mockResolvedValue([alert('stall:g-inbox', 'desk · Inbox stalled: nothing integrated for 6 hours', { kind: 'goal', id: 'g-inbox' })]);
    const run = vi.spyOn(api, 'run');
    renderForemanApp('/foreman/alerts', api);
    fireEvent.click(await screen.findByRole('link', { name: /Open goal/ }));
    expect(await screen.findByRole('heading', { name: 'desk · Inbox at 100% Libredesk parity' })).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });

  it('shows the run page when the owner follows an alert about a run', async () => {
    renderForemanApp('/foreman/alerts');
    fireEvent.click(await screen.findByRole('link', { name: /Open run/ }));
    expect(await screen.findByText(/^deepseek-chat · sandboxed · turn 14 · 23m$/)).toBeTruthy();
  });

  it('has no link for an alert about nothing a page shows, or about a kind this build does not know', async () => {
    const api = quickApi();
    vi.spyOn(api, 'alerts').mockResolvedValue([
      alert('lost:postgres', 'postgres is unavailable', null),
      alert('new-kind', 'something about an experiment', { kind: 'experiment', id: 'x1' } as unknown as EntityRef),
    ]);
    renderForemanApp('/foreman/alerts', api);
    expect(await screen.findByText('something about an experiment')).toBeTruthy();
    expect(screen.getByText('postgres is unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/alerts\.open|undefined/);
  });
});

describe('entityPath', () => {
  it('gives each kind its own page and an unknown kind none', () => {
    expect(entityPath({ kind: 'goal', id: 'g1' })).toBe('/foreman/work/g1');
    expect(entityPath({ kind: 'run', id: 'r1' })).toBe('/foreman/work/runs/r1');
    expect(entityPath({ kind: 'decision', id: 'd1' })).toBe('/foreman/decisions/d1');
    expect(entityPath({ kind: 'lesson', id: 'l1' } as unknown as EntityRef)).toBeNull();
  });
});

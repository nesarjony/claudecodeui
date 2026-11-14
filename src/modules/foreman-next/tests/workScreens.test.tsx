import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

describe('Work', () => {
  it('shows the board: a goal in two columns, handed-over sessions among the active work, queued and done goals', async () => {
    renderForemanApp('/foreman/work');
    expect(await screen.findByText('Programme: desk parity, 47 screens')).toBeTruthy();
    const waiting = await screen.findByRole('region', { name: 'Waiting on you' });
    expect(within(waiting).getByText('2 decisions hold 35')).toBeTruthy();
    expect(within(waiting).getByText(/^65\/120/)).toBeTruthy();
    const active = screen.getByRole('region', { name: 'Active' });
    expect(within(active).getByText('batch 4 of 13')).toBeTruthy();
    expect(within(active).getByText('desk boss')).toBeTruthy();
    expect(within(active).getByText('handed over')).toBeTruthy();
    expect(within(active).getByRole('heading', { name: 'Active (2)' })).toBeTruthy();
    const queued = screen.getByRole('region', { name: 'Queued' });
    expect(within(queued).getAllByText('no strategy yet')).toHaveLength(2);
    expect(within(queued).getByText('queued after Inbox')).toBeTruthy();
    const done = screen.getByRole('region', { name: 'Done' });
    expect(within(done).getByText('12/12 · 2 days')).toBeTruthy();
    expect(within(done).getByText('$3.10')).toBeTruthy();
  });

  it('switches to the list view', async () => {
    renderForemanApp('/foreman/work');
    await screen.findByRole('region', { name: 'Queued' });
    fireEvent.click(screen.getByLabelText('List'));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 4 + 1);
    expect(within(table).getByRole('link', { name: 'desk boss' })).toBeTruthy();
  });

  it('starts a goal, lands on its page with the strategy waiting for approval, and approves it', async () => {
    renderForemanApp('/foreman/work');
    fireEvent.click(await screen.findByRole('button', { name: '+ New goal' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create goal' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Repo'), { target: { value: 'desk' } });
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Reports' } });
    fireEvent.click(create);
    expect(await screen.findByText('Waiting for your approval before any worker starts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('Waiting for your approval before any worker starts')).toBeNull());
  });

  it('shows the goal page: progress, forecast, spend, the strategy and the batches', async () => {
    renderForemanApp('/foreman/work/g-inbox');
    expect(await screen.findByRole('heading', { name: 'desk · Inbox at 100% Libredesk parity' })).toBeTruthy();
    expect(screen.getByText('Done when: all 120 checklist rows are DONE and verified by the judge')).toBeTruthy();
    expect(screen.getByText('DONE 65')).toBeTruthy();
    expect(screen.getByText('BUILT 3')).toBeTruthy();
    expect(screen.getByText('TODO 52')).toBeTruthy();
    expect(screen.getByText(/about 9 more batches · \$11 of API credit · 4 MiniMax windows · done around \w{3} \(likely\)/)).toBeTruthy();
    expect(screen.getByText(/\$12\.40 of the \$40 share · first-pass yield 91% · \$0\.38 per DONE row/)).toBeTruthy();
    const strategy = screen.getByRole('region', { name: 'Strategy v2' });
    expect(within(strategy).getAllByRole('listitem')).toHaveLength(3);
    expect(within(strategy).getByText(/Risk: realtime rows wait on your transport decision/)).toBeTruthy();
    fireEvent.click(within(strategy).getByRole('button', { name: 'Compare v1' }));
    expect(within(strategy).getByText('Fix batch last')).toBeTruthy();
  });

  it('lists the batches that matter, links a waiting batch to its decision, and expands to all of them', async () => {
    renderForemanApp('/foreman/work/g-inbox');
    const batches = await screen.findByRole('region', { name: 'Batches' });
    expect(within(batches).getByText('worker · turn 14')).toBeTruthy();
    expect(within(batches).getByText('waits on: Bulk actions in v1?')).toBeTruthy();
    expect(within(batches).getByText('9 of 10 first pass')).toBeTruthy();
    expect(within(batches).getAllByRole('link', { name: 'Decide' })[0]?.getAttribute('href')).toBe('/foreman/decide/needs/q-bulk');
    const before = within(batches).getAllByRole('listitem').length;
    fireEvent.click(within(batches).getByRole('button', { name: 'All 13 batches' }));
    expect(within(batches).getAllByRole('listitem')).toHaveLength(13);
    expect(before).toBeLessThan(13);
  });

  it('pauses and resumes a goal, and re-plans it', async () => {
    const api = quickApi();
    const replan = vi.spyOn(api, 'replanGoal');
    renderForemanApp('/foreman/work/g-inbox', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-plan' }));
    await waitFor(() => expect(replan).toHaveBeenCalledWith('g-inbox'));
    expect(await screen.findByRole('region', { name: 'Strategy v3' })).toBeTruthy();
  });

  it('adjusts a strategy that waits for approval with a note', async () => {
    const api = quickApi();
    const created = await api.createGoal({ repo: 'desk', goal: 'Reports' });
    const adjust = vi.spyOn(api, 'adjustStrategy');
    renderForemanApp(`/foreman/work/${created.id}`, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'Fewer, bigger batches' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(adjust).toHaveBeenCalledWith(created.id, 'Fewer, bigger batches'));
  });
});


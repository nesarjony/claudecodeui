import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

describe('the run view', () => {
  it('shows a live run: stages, Foreman\'s decisions with the card behind a steer, the worker, and the pending verdict', async () => {
    renderForemanApp('/foreman/work/runs/run-t2');
    expect(await screen.findByText(/MiniMax-M3 · sandboxed · turn 14 · 23m · MiniMax 3% of the 5h window/)).toBeTruthy();
    const stages = screen.getByRole('list', { name: 'Stages' });
    expect(within(stages).getAllByRole('listitem').map((item) => item.textContent?.replace(/[─▸\s]+$/, '').trim())).toEqual(['Brief ✓', 'Worker ●', 'Checks ○', 'Judge ○', 'Close ○']);
    expect(screen.getByText(/when the worker says done, asks something, or goes 10 turns without a commit/)).toBeTruthy();
    const decisions = screen.getByRole('region', { name: 'Foreman decisions' });
    expect(within(decisions).getAllByRole('listitem')).toHaveLength(4);
    expect(within(decisions).getByText('Opus · $0.04')).toBeTruthy();
    expect(within(decisions).getByText(/"Reuse useConversationList; don't add a second fetch\."/)).toBeTruthy();
    expect(within(decisions).getByRole('link', { name: 'Card' }).getAttribute('href')).toBe('/foreman/decisions/dec-steer-9');
    const worker = screen.getByRole('region', { name: 'Worker' });
    expect(within(worker).getByText('editing InboxLayout.tsx')).toBeTruthy();
    expect(within(worker).getByText('4 files · +212 −31')).toBeTruthy();
    expect(within(worker).getByRole('link', { name: /Open session/ }).getAttribute('href')).toBe('/session/sess-t2-layout');
    expect(screen.getByText('The checks and the judge run after the worker finishes.')).toBeTruthy();
  });

  it('shows the checks and the judge\'s verdict row by row once the worker has finished', async () => {
    renderForemanApp('/foreman/work/runs/run-t1');
    const verdict = await screen.findByRole('region', { name: /Checks and verdict/ });
    expect(within(verdict).getByText('pnpm verify exit 0, run by Foreman in a clean copy')).toBeTruthy();
    expect(within(verdict).getByText('header 8px taller')).toBeTruthy();
    expect(within(verdict).getAllByRole('img', { name: 'failed' })).toHaveLength(1);
    expect(within(verdict).getAllByRole('img', { name: 'passed' })).toHaveLength(5);
    expect(within(verdict).getByText("row 83 goes back to the worker with the judge's reason")).toBeTruthy();
    expect(within(verdict).getByRole('link', { name: /Output/ })).toBeTruthy();
  });

  it('pauses, resumes and stops a run, and replays it from a step', async () => {
    const api = quickApi();
    const replay = vi.spyOn(api, 'replayRun');
    renderForemanApp('/foreman/work/runs/run-t2', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Replay from step...'), { target: { value: 'checks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith('run-t2', 'checks'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  });

  it('takes the run over and lands in its session', async () => {
    const api = quickApi();
    const takeOver = vi.spyOn(api, 'takeOverRun');
    renderForemanApp('/foreman/work/runs/run-t2', api);
    fireEvent.click(await screen.findByRole('button', { name: /Take over/ }));
    expect(await screen.findByText('session view')).toBeTruthy();
    expect(takeOver).toHaveBeenCalledWith('run-t2');
  });

  it('shows the failed step, the reason and what Foreman chose next', async () => {
    renderForemanApp('/foreman/work/runs/run-t2', quickApi('run-failed'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Failed at Worker: The worker stopped after a model refusal on turn 14 and made no commit. Foreman chose to retry.');
    expect(screen.getByRole('img', { name: 'failed' })).toBeTruthy();
  });

  it('says "You\'re driving" with Hand back when the owner has taken over, and hands back', async () => {
    renderForemanApp('/foreman/work/runs/run-t2', quickApi('taken-over'));
    const banner = await screen.findByText("You're driving. Foreman paused supervision of t2-layout and will resume when you hand back.");
    expect(banner).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hand back to Foreman' }));
    await waitFor(() => expect(screen.queryByText(/You're driving/)).toBeNull());
    expect(await screen.findByRole('button', { name: /Take over/ })).toBeTruthy();
  });

  it('shows a handed-over session as a run: attached, supervised, with Take back and no worker controls', async () => {
    const api = quickApi();
    const takeBack = vi.spyOn(api, 'takeBackSession');
    renderForemanApp('/foreman/work/runs/run-ho-boss', api);
    const banner = await screen.findByText(/Foreman is supervising your session desk boss, turn by turn\./);
    expect(banner.textContent).toMatch(/Goal: finish the Contacts import\./);
    const stages = screen.getByRole('list', { name: 'Stages' });
    expect(within(stages).getAllByRole('listitem')[0]?.textContent).toMatch(/^Attach/);
    expect(screen.getByRole('region', { name: 'Session' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull();
    expect(screen.queryByLabelText('Replay from step...')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }));
    expect(await screen.findByText(/You took desk boss back\. Foreman no longer supervises it\./)).toBeTruthy();
    expect(takeBack).toHaveBeenCalledWith('sess-desk-boss');
    expect(screen.queryByRole('button', { name: 'Take back' })).toBeNull();
  });
});


describe('Settings', () => {
  it('shows the trust ladder and the attention policy', async () => {
    renderForemanApp('/foreman/settings');
    expect(await screen.findByText('Product scope')).toBeTruthy();
    expect(screen.getByText(/Foreman may suggest moving a kind up a level after 10 decisions with 90% agreement/)).toBeTruthy();
    const attention = await screen.findByRole('region', { name: 'Attention · what interrupts you' });
    expect(within(attention).getAllByRole('row')).toHaveLength(8);
    expect((within(attention).getByLabelText('Phone delay for: A decision that blocks nothing urgent') as HTMLSelectElement).value).toBe('240');
    expect((within(attention).getByLabelText('Quiet hours from') as HTMLInputElement).value).toBe('23:00');
    expect(within(attention).getByText('Quiet hours hold everything except stop events.')).toBeTruthy();
  });

  it('shows the read-only lines: budget, MiniMax, models, roles with the editor, and each repo', async () => {
    renderForemanApp('/foreman/settings');
    const facts = await screen.findByRole('region', { name: 'Budget, models and repos' });
    expect(within(facts).getByText('API $200 a month (owner only) · pace about $6.50 a day · goal share: Inbox $40')).toBeTruthy();
    expect(within(facts).getByText('stop desk workers at 80% of the 5-hour or weekly window; the rest stays yours; auto-resume')).toBeTruthy();
    expect(within(facts).getByText('Opus (API credit) · desk workers MiniMax-M3 only · side runs MiniMax')).toBeTruthy();
    expect(within(facts).getByText(/Strategist v3 · Supervisor v3 · Judge v4 · Coach v1/)).toBeTruthy();
    expect(within(facts).getByRole('link', { name: /Editor/ }).getAttribute('href')).toBe('http://127.0.0.1:4111');
    expect(within(facts).getByText(/checks: pnpm verify · 7 protected paths · infigraph ✓ indexed \d{2}:\d{2}/)).toBeTruthy();
    expect(within(facts).getByText('checks: npm test · 2 protected paths · infigraph not indexed')).toBeTruthy();
    expect(within(facts).queryByRole('button')).toBeNull();
  });

  it('saves an edited attention policy', async () => {
    const api = quickApi();
    const save = vi.spyOn(api, 'setAttention');
    renderForemanApp('/foreman/settings', api);
    const attention = await screen.findByRole('region', { name: 'Attention · what interrupts you' });
    fireEvent.change(await within(attention).findByLabelText('Phone for: Routine turns and decisions'), { target: { value: 'delayed' } });
    fireEvent.click(within(attention).getByLabelText('Morning briefing for: Routine turns and decisions'));
    fireEvent.change(within(attention).getByLabelText('Briefing at'), { target: { value: '07:30' } });
    fireEvent.click(within(attention).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const sent = save.mock.calls[0]?.[0];
    expect(sent?.briefingAt).toBe('07:30');
    expect(sent?.rules.find((rule) => rule.event === 'routine')).toEqual({ event: 'routine', phone: 'delayed', phoneDelayMinutes: 30, briefing: true });
  });
});


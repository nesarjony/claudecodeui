import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { settingsFixture } from '@/modules/foreman-next/api/mock/settingsFixtures';
import { SettingsFacts } from '@/modules/foreman-next/settings/SettingsFacts';
import { quickApi, renderForemanApp, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';
import { ApiRequestError } from '@/shared/api';

describe('the run view', () => {
  it('shows a live run: stages, Foreman\'s decisions with the card behind a steer, the worker, and the pending verdict', async () => {
    renderForemanApp('/foreman/work/runs/run-t2');
    // The run header names the model, the clock and the turn, and no plan-window gauge.
    expect(await screen.findByText(/^deepseek-chat · sandboxed · turn 14 · 23m$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/MiniMax|of the 5h window/);
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

  it('shows the read-only lines: budget, plan window, models and roles with the editor', async () => {
    renderForemanApp('/foreman/settings');
    const facts = await screen.findByRole('region', { name: 'Budget and models' });
    expect(within(facts).getByText('API $200 a month (owner only) · pace about $6.50 a day · goal share: Inbox $40')).toBeTruthy();
    expect(within(facts).getByText('Plan window')).toBeTruthy();
    expect(within(facts).getByText('none watched: DeepSeek is pay-per-token, so it has no plan window to stop at')).toBeTruthy();
    expect(within(facts).getByText('Opus (API credit) · desk workers DeepSeek only · side runs DeepSeek')).toBeTruthy();
    expect(facts.textContent).not.toMatch(/MiniMax/);
    expect(within(facts).getByText(/Strategist v3 · Supervisor v3 · Judge v4 · Coach v1/)).toBeTruthy();
    expect(within(facts).getByRole('link', { name: /Editor/ }).getAttribute('href')).toBe('http://127.0.0.1:4111');
    expect(within(facts).queryByRole('button')).toBeNull();
  });

  it('states a watched plan window neutrally, with the stop point and whether workers resume by themselves', () => {
    const settings = settingsFixture();
    const { unmount } = renderWithForeman(<SettingsFacts settings={{ ...settings, minimax: { stopAtPct: 80, autoResume: true } }} editorUrl={null} />);
    expect(screen.getByText('stop desk workers at 80% of a 5-hour or weekly plan window; the rest stays yours; auto-resume')).toBeTruthy();
    unmount();
    renderWithForeman(<SettingsFacts settings={{ ...settings, minimax: { stopAtPct: 80, autoResume: false } }} editorUrl={null} />);
    expect(screen.getByText('stop desk workers at 80% of a 5-hour or weekly plan window; the rest stays yours')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/MiniMax/);
  });

  it('lists the registry: each repo as registered, what its adapter says of it, and the switch for workers on a read-only one', async () => {
    renderForemanApp('/foreman/settings');
    const repos = await screen.findByRole('region', { name: 'Repos' });
    expect(await within(repos).findByText('/mnt/dev/moveon/desk')).toBeTruthy();
    expect(within(repos).getByText('desk adapter · branch feature/scaffold · checks: pnpm verify · 7 protected paths · 1 setup file pinned', { exact: false })).toBeTruthy();
    expect(within(repos).getByText('scratch adapter · branch main · checks: npm test · 2 protected paths · 0 setup files pinned · infigraph not indexed')).toBeTruthy();
    expect((within(repos).getByLabelText(/Workers may start on desk \(its adapter makes it read-only/) as HTMLInputElement).checked).toBe(false);
    const scratch = within(repos).getByLabelText('Workers may start on scratch (its adapter allows them)') as HTMLInputElement;
    expect([scratch.checked, scratch.disabled]).toEqual([true, true]);
  });

  it('turns workers on for a read-only repo, and shows it after it saved', async () => {
    const api = quickApi();
    const turn = vi.spyOn(api, 'setRepoWorkers');
    renderForemanApp('/foreman/settings', api);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    fireEvent.click(await within(repos).findByLabelText(/Workers may start on desk \(its adapter makes it read-only/));
    await waitFor(() => expect(turn).toHaveBeenCalledWith('desk', true));
    await waitFor(() => expect((within(repos).getByLabelText(/Workers may start on desk/) as HTMLInputElement).checked).toBe(true));
  });

  it('adds a repo with the owner\'s words, and shows Foreman\'s own reason when it refuses one', async () => {
    const api = quickApi();
    const add = vi.spyOn(api, 'setRepo');
    renderForemanApp('/foreman/settings', api);
    const form = await screen.findByRole('form', { name: 'Add a repo' });
    const submit = within(form).getByRole('button', { name: 'Add repo' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'portal' } });
    fireEvent.change(within(form).getByLabelText('Directory (absolute path)'), { target: { value: '/mnt/dev/portal' } });
    fireEvent.change(within(form).getByLabelText('Adapter'), { target: { value: 'scratch' } });
    fireEvent.click(submit);
    await waitFor(() => expect(add).toHaveBeenCalledWith('portal', { directory: '/mnt/dev/portal', adapter: 'scratch', baseBranch: null }));
    expect(await screen.findByText('/mnt/dev/portal')).toBeTruthy();

    add.mockRejectedValueOnce(new ApiRequestError('Foreman has no adapter named nope: it has scratch, desk', { code: 'invalid', status: 400 }));
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'other' } });
    fireEvent.change(within(form).getByLabelText('Directory (absolute path)'), { target: { value: '/mnt/dev/other' } });
    fireEvent.change(within(form).getByLabelText('Adapter'), { target: { value: 'nope' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add repo' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Foreman has no adapter named nope: it has scratch, desk');
  });

  it('changes a repo in place, starting from what is registered, and shows the refusal while goals are open on it', async () => {
    const api = quickApi();
    const change = vi.spyOn(api, 'setRepo');
    renderForemanApp('/foreman/settings', api);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    fireEvent.click((await within(repos).findAllByRole('button', { name: 'Change' }))[0] as HTMLElement);
    const form = within(repos).getByRole('form', { name: 'Change desk' });
    expect((within(form).getByLabelText('Directory (absolute path)') as HTMLInputElement).value).toBe('/mnt/dev/moveon/desk');
    fireEvent.change(within(form).getByLabelText(/Base branch/), { target: { value: 'main' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(change).toHaveBeenCalledWith('desk', { directory: '/mnt/dev/moveon/desk', adapter: 'desk', baseBranch: 'main' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Goals are open on this repo');
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


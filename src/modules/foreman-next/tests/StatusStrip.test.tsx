import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { DegradedMode, ForemanApi } from '@/modules/foreman-next/api/contract';
import { ForemanStatusProvider } from '@/modules/foreman-next/context/ForemanStatusProvider';
import { statusFixture } from '@/modules/foreman-next/api/mock/shellFixtures';
import { ConnectionBanner } from '@/modules/foreman-next/shell/ConnectionBanner';
import { StatusStrip } from '@/modules/foreman-next/shell/StatusStrip';
import { StatusSummary } from '@/modules/foreman-next/shell/StatusSummary';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const shell = (children?: ReactNode) => (
  <ForemanStatusProvider>
    <StatusStrip chatOpen={false} chatButtonRef={{ current: null }} onToggleChat={vi.fn()} />
    <ConnectionBanner />
    {children}
  </ForemanStatusProvider>
);

const strip = async (api: ForemanApi) => {
  renderWithForeman(shell(), { api });
  return screen.findByRole('banner', { name: 'Foreman status' });
};

describe('the status strip', () => {
  it('shows the run state, the API credit and DeepSeek spend apart, and alerts, with the global controls', async () => {
    const banner = await strip(quickApi());
    expect(within(banner).getByText('Running')).toBeTruthy();
    expect(within(banner).getByText('API credit $41.20 of $200')).toBeTruthy();
    expect(within(banner).getByText('DeepSeek $0.42')).toBeTruthy();
    expect(within(banner).getByText('! 1 alert')).toBeTruthy();
    for (const name of ['Pause all', 'Stop all']) expect(within(banner).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    expect(within(banner).getByRole('button', { name: /Chat/ }).getAttribute('aria-keyshortcuts')).toBe('Meta+J Control+J');
  });

  it('shows the API ceiling pause with the resume day and who can lift it', async () => {
    const banner = await strip(quickApi('budget-paused'));
    expect(await within(banner).findByText(/Paused · API ceiling reached · resumes .+, or raise it \(owner only\)/)).toBeTruthy();
    expect((within(banner).getByRole('button', { name: /Pause all/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a plan-window pause neutrally: workers paused, when they resume, and that Foreman keeps planning, with no gauge', async () => {
    const banner = await strip(quickApi('plan-window-paused'));
    expect(await within(banner).findByText(/Workers paused · the workers' plan window is full · resumes \d{2}:\d{2}\. Foreman keeps planning\./)).toBeTruthy();
    expect(banner.textContent).not.toMatch(/MiniMax|80%|31%|5h|wk/);
  });

  it('shows no plan-window gauge, even when Foreman still sends the old minimax reading', async () => {
    const banner = await strip(quickApi('plan-window-paused'));
    await within(banner).findByText(/Workers paused/);
    expect(banner.textContent).not.toMatch(/MiniMax|5h|wk|%/);
    expect(within(banner).getByText('API credit $41.20 of $200')).toBeTruthy();
  });

  it('shows an em dash for DeepSeek when its spend could not be read, never $NaN, $null or a $0.00 that is not a reading', async () => {
    const banner = await strip(quickApi('deepseek-unread'));
    expect(await within(banner).findByText('DeepSeek —')).toBeTruthy();
    expect(within(banner).getByText('API credit $41.20 of $200')).toBeTruthy();
    expect(banner.textContent).not.toMatch(/NaN|null|undefined|\$0\.00/);
    expect(within(banner).getByTitle("DeepSeek's spend this month could not be read just now")).toBeTruthy();
  });

  it('treats a missing deepseekMonthUsd, as an older Foreman sends it, like an unread one', () => {
    const status = statusFixture();
    const { monthUsd, ceilingUsd, paceUsdPerDay } = status.spend;
    renderWithForeman(<StatusSummary status={{ ...status, spend: { monthUsd, ceilingUsd, paceUsdPerDay } as typeof status.spend }} />);
    expect(screen.getByText('DeepSeek —')).toBeTruthy();
  });

  it('shows a real DeepSeek zero as $0.00, apart from a reading that failed', () => {
    const status = statusFixture();
    renderWithForeman(<StatusSummary status={{ ...status, spend: { ...status.spend, deepseekMonthUsd: 0 } }} />);
    expect(screen.getByText('DeepSeek $0.00')).toBeTruthy();
  });

  it("says the workers' plan window paused things when the reason arrives on a paused state, and does not crash without a resume time", () => {
    const status = statusFixture();
    renderWithForeman(<StatusSummary status={{ ...status, state: 'paused', pauseReason: 'minimax-window', resumesAt: null }} />);
    expect(screen.getByText("Workers paused · the workers' plan window is full. Foreman keeps planning.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/MiniMax/);
  });

  it('lists every degraded mode with what Foreman does meanwhile (BR-10.10)', async () => {
    const banner = await strip(quickApi('degraded'));
    const modes = await within(banner).findByRole('status', { name: 'Degraded modes' });
    const items = within(modes).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    const expected: [string, RegExp][] = [
      ['API credit unavailable', /no new batches start/],
      ['DeepSeek unavailable', /Workers pause at a safe point/],
      ['cloudcli unavailable', /Nothing new starts/],
      ['Database unavailable', /Workers keep their sessions/],
      ['The code-structure index is unavailable', /Plans are made without it/],
      ['Owner away', /one digest/],
    ];
    expected.forEach(([title, detail], position) => {
      expect(within(items[position] as HTMLElement).getByText(title)).toBeTruthy();
      expect(within(items[position] as HTMLElement).getByText(detail)).toBeTruthy();
    });
  });

  it('titles the loss of the worker and helper routes DeepSeek, though Foreman still names that mode minimax', async () => {
    const banner = await strip(quickApi('degraded'));
    const modes = await within(banner).findByRole('status', { name: 'Degraded modes' });
    expect(within(modes).getByText('DeepSeek unavailable')).toBeTruthy();
    expect(modes.textContent).not.toMatch(/MiniMax/);
  });

  it('shows a degraded mode this build does not know as "Degraded: <mode>" with its alert, and keeps the known ones', async () => {
    const api = quickApi();
    const status = await api.status();
    vi.spyOn(api, 'status').mockResolvedValue({
      ...status,
      degraded: [
        { mode: 'api-credit', since: new Date().toISOString() },
        { mode: 'tape-drive' as DegradedMode, since: new Date().toISOString() },
      ],
    });
    vi.spyOn(api, 'alerts').mockResolvedValue([{ id: 'lost:tape-drive', severity: 'critical', text: 'tape-drive is unavailable: 96% full', at: new Date().toISOString(), subject: null }]);
    const banner = await strip(api);
    const modes = await within(banner).findByRole('status', { name: 'Degraded modes' });
    const items = within(modes).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('API credit unavailable')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('Degraded: tape-drive')).toBeTruthy();
    expect(await within(items[1] as HTMLElement).findByText('tape-drive is unavailable: 96% full')).toBeTruthy();
    expect(modes.textContent).not.toMatch(/degraded\.|undefined/);
  });

  it('says so, without an alert to quote, for an unknown degraded mode', async () => {
    const api = quickApi();
    const status = await api.status();
    vi.spyOn(api, 'status').mockResolvedValue({ ...status, degraded: [{ mode: 'tape-drive' as DegradedMode, since: new Date().toISOString() }] });
    vi.spyOn(api, 'alerts').mockResolvedValue([]);
    const banner = await strip(api);
    const modes = await within(banner).findByRole('status', { name: 'Degraded modes' });
    expect(within(modes).getByText('Degraded: tape-drive')).toBeTruthy();
    expect(await within(modes).findByText(/Foreman reports this mode as degraded, but this screen has no description of it yet/)).toBeTruthy();
  });

  it('shows no degraded list while everything is available', async () => {
    const banner = await strip(quickApi());
    await within(banner).findByText('Running');
    expect(within(banner).queryByRole('status', { name: 'Degraded modes' })).toBeNull();
  });

  it('pauses everything, then offers Resume', async () => {
    const api = quickApi();
    const pause = vi.spyOn(api, 'pauseAll');
    const banner = await strip(api);
    fireEvent.click(await within(banner).findByRole('button', { name: /Pause all/ }));
    expect(await within(banner).findByText('Paused by you')).toBeTruthy();
    expect(pause).toHaveBeenCalledOnce();
    expect(within(banner).getByRole('button', { name: /Resume all/ })).toBeTruthy();
  });

  it('asks before stopping all work, and stops only on confirmation', async () => {
    const api = quickApi();
    const stop = vi.spyOn(api, 'stopAll');
    const banner = await strip(api);
    fireEvent.click(await within(banner).findByRole('button', { name: /Stop all/ }));
    const dialog = await screen.findByRole('dialog');
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all' }));
    expect(await within(banner).findByText(/Stopped · nothing runs until you resume/)).toBeTruthy();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not stop anything when the confirmation is cancelled', async () => {
    const api = quickApi();
    const stop = vi.spyOn(api, 'stopAll');
    const banner = await strip(api);
    fireEvent.click(await within(banner).findByRole('button', { name: /Stop all/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('the connection banner', () => {
  it('says Foreman is not responding, and offers Retry and the service log', async () => {
    const api = quickApi('unreachable');
    renderWithForeman(shell(), { api });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Foreman isn't responding. Workers keep their sessions; nothing is lost.")).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Service log' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/foreman\.service started/)).toBeTruthy();
  });

  it('shows the strip as unknown rather than guessing while Foreman does not answer', async () => {
    renderWithForeman(shell(), { api: quickApi('unreachable') });
    expect(await screen.findByText('Foreman status unknown')).toBeTruthy();
  });

  it('says the network is gone when the browser goes offline, and clears when it returns', async () => {
    renderWithForeman(shell());
    await screen.findByText('Running');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => void window.dispatchEvent(new Event('offline')));
    expect((await screen.findByRole('alert')).textContent).toMatch(/You are offline/);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows nothing while Foreman answers', async () => {
    renderWithForeman(shell());
    await screen.findByText('Running');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

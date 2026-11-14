import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { ForemanStatusProvider } from '@/modules/foreman-next/context/ForemanStatusProvider';
import { ConnectionBanner } from '@/modules/foreman-next/shell/ConnectionBanner';
import { StatusStrip } from '@/modules/foreman-next/shell/StatusStrip';
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
  it('shows the run state, API spend, MiniMax windows and alerts, with the global controls', async () => {
    const banner = await strip(quickApi());
    expect(within(banner).getByText('Running')).toBeTruthy();
    expect(within(banner).getByText('API $41.20 of $200')).toBeTruthy();
    expect(within(banner).getByText('MiniMax 5h 34% · wk 12%')).toBeTruthy();
    expect(within(banner).getByText('! 1 alert')).toBeTruthy();
    for (const name of ['Pause all', 'Stop all']) expect(within(banner).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    expect(within(banner).getByRole('button', { name: /Chat/ }).getAttribute('aria-keyshortcuts')).toBe('Meta+J Control+J');
  });

  it('shows the API ceiling pause with the resume day and who can lift it', async () => {
    const banner = await strip(quickApi('budget-paused'));
    expect(await within(banner).findByText(/Paused · API ceiling reached · resumes .+, or raise it \(owner only\)/)).toBeTruthy();
    expect((within(banner).getByRole('button', { name: /Pause all/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the MiniMax window pause: workers paused, when they resume, and that Foreman keeps planning', async () => {
    const banner = await strip(quickApi('minimax-paused'));
    expect(await within(banner).findByText(/Workers paused · MiniMax 5h window at 80% · resumes \d{2}:\d{2}\. Foreman keeps planning\./)).toBeTruthy();
  });

  it('lists every degraded mode with what Foreman does meanwhile (BR-10.10)', async () => {
    const banner = await strip(quickApi('degraded'));
    const modes = await within(banner).findByRole('status', { name: 'Degraded modes' });
    const items = within(modes).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    const expected: [string, RegExp][] = [
      ['API credit unavailable', /no new batches start/],
      ['MiniMax unavailable', /Workers pause at a safe point/],
      ['cloudcli unavailable', /Nothing new starts/],
      ['Database unavailable', /Workers keep their sessions/],
      ['infigraph unavailable', /file paths from git/],
      ['Owner away', /one digest/],
    ];
    expected.forEach(([title, detail], position) => {
      expect(within(items[position] as HTMLElement).getByText(title)).toBeTruthy();
      expect(within(items[position] as HTMLElement).getByText(detail)).toBeTruthy();
    });
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

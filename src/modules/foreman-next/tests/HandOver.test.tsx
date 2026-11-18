import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ForemanNextRoute, ForemanSessionBar, ForemanSidebarEntry } from '@/modules/foreman-next/ForemanNextLazy';
import { SessionSupervisionBar } from '@/modules/foreman-next/handover/SessionSupervisionBar';
import { HandOverDialog } from '@/modules/foreman-next/modals/HandOverDialog';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

describe('the Hand to Foreman dialog', () => {
  it('hands the session over with no goal when the field is left empty', async () => {
    const api = quickApi();
    const handOver = vi.spyOn(api, 'handOverSession');
    const onClose = vi.fn();
    renderWithForeman(<HandOverDialog sessionId="sess-free" onClose={onClose} />, { api });
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Goal (optional)') as HTMLInputElement).placeholder).toBe('take this over');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(handOver).toHaveBeenCalledWith('sess-free', undefined);
  });

  it('sends the goal the owner typed', async () => {
    const api = quickApi();
    const handOver = vi.spyOn(api, 'handOverSession');
    renderWithForeman(<HandOverDialog sessionId="sess-free" onClose={vi.fn()} />, { api });
    fireEvent.change(screen.getByLabelText('Goal (optional)'), { target: { value: '  finish the Contacts import ' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(handOver).toHaveBeenCalled());
    expect(handOver).toHaveBeenCalledWith('sess-free', 'finish the Contacts import');
  });

  it('is operated from the keyboard: it focuses the goal field, closes on Escape and hands over nothing', () => {
    const api = quickApi();
    const handOver = vi.spyOn(api, 'handOverSession');
    const onClose = vi.fn();
    renderWithForeman(<HandOverDialog sessionId="sess-free" onClose={onClose} />, { api });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(handOver).not.toHaveBeenCalled();
  });

  it('cancels without handing anything over', () => {
    const api = quickApi();
    const handOver = vi.spyOn(api, 'handOverSession');
    const onClose = vi.fn();
    renderWithForeman(<HandOverDialog sessionId="sess-free" onClose={onClose} />, { api });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(handOver).not.toHaveBeenCalled();
  });

  it('says so and stays open when the hand-over is refused', async () => {
    const api = quickApi();
    const onClose = vi.fn();
    renderWithForeman(<HandOverDialog sessionId="sess-t2-layout" onClose={onClose} />, { api });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the session bar', () => {
  it('offers Hand to Foreman on an owner session, opens the dialog, and shows the supervision once handed over', async () => {
    const api = quickApi();
    renderWithForeman(<SessionSupervisionBar sessionId="sess-free" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Hand to Foreman' }));
    fireEvent.change(screen.getByLabelText('Goal (optional)'), { target: { value: 'finish the import' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    expect(await screen.findByText(/Foreman is supervising this session\. Goal: finish the import\./)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hand to Foreman' })).toBeNull();
  });

  it('shows who has a session Foreman already supervises, with a way to watch it and to take it back', async () => {
    renderWithForeman(<SessionSupervisionBar sessionId="sess-desk-boss" />);
    const banner = await screen.findByRole('status');
    expect(within(banner).getByText(/Foreman is supervising this session\. Goal: finish the Contacts import\./)).toBeTruthy();
    expect(within(banner).getByRole('link', { name: /Watch in Foreman/ }).getAttribute('href')).toBe('/foreman/work/runs/run-ho-boss');
    expect(within(banner).getByRole('button', { name: 'Take back' })).toBeTruthy();
  });

  it('takes the session back: Foreman stops supervising and Hand to Foreman returns', async () => {
    const api = quickApi();
    const takeBack = vi.spyOn(api, 'takeBackSession');
    renderWithForeman(<SessionSupervisionBar sessionId="sess-desk-boss" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Take back' }));
    expect(await screen.findByRole('button', { name: 'Hand to Foreman' })).toBeTruthy();
    expect(takeBack).toHaveBeenCalledWith('sess-desk-boss');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the banner and says so when taking back fails', async () => {
    const api = quickApi();
    vi.spyOn(api, 'takeBackSession').mockRejectedValue(new Error('down'));
    renderWithForeman(<SessionSupervisionBar sessionId="sess-desk-boss" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Take back' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take back' })).toBeTruthy();
  });

  it('shows the Foreman worker banner on a worker session, with Watch in Foreman and Take over, and no hand-over', async () => {
    renderWithForeman(<SessionSupervisionBar sessionId="sess-t2-layout" />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Foreman worker · desk · Inbox · batch t2-layout · deepseek-chat · sandboxed · supervised');
    expect(within(banner).getByText(/Foreman's messages in this session are labelled "Foreman"\./)).toBeTruthy();
    expect(within(banner).getByRole('link', { name: /Watch in Foreman/ }).getAttribute('href')).toBe('/foreman/work/runs/run-t2');
    expect(within(banner).getByRole('button', { name: 'Take over' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hand to Foreman' })).toBeNull();
  });

  it('takes a worker session over: "You\'re driving" with Hand back, then back to supervised', async () => {
    const api = quickApi();
    const takeOver = vi.spyOn(api, 'takeOverRun');
    const handBack = vi.spyOn(api, 'handBackRun');
    renderWithForeman(<SessionSupervisionBar sessionId="sess-t2-layout" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(await screen.findByText("You're driving. Foreman paused supervision of t2-layout and will resume when you hand back.")).toBeTruthy();
    expect(takeOver).toHaveBeenCalledWith('run-t2');
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hand back to Foreman' }));
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeTruthy();
    expect(handBack).toHaveBeenCalledWith('run-t2');
  });

  it('opens already driving when the owner took the worker over before', async () => {
    renderWithForeman(<SessionSupervisionBar sessionId="sess-t2-layout" />, { api: quickApi('taken-over') });
    expect(await screen.findByText(/You're driving/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hand back to Foreman' })).toBeTruthy();
  });

  it('keeps the banner and says so when taking over fails', async () => {
    const api = quickApi();
    vi.spyOn(api, 'takeOverRun').mockRejectedValue(new Error('down'));
    renderWithForeman(<SessionSupervisionBar sessionId="sess-t2-layout" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy();
  });

  it('renders nothing at all while the new Foreman UI is switched off: no session bar, no sidebar entry, no route', () => {
    const { container } = render(
      <>
        <ForemanSessionBar sessionId="sess-free" />
        <ForemanSidebarEntry />
        <ForemanNextRoute />
      </>,
    );
    expect(container.innerHTML).toBe('');
  });
});

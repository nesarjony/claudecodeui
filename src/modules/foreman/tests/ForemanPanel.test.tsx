import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ApiRequestError } from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';
import { foremanTabApi } from '@/modules/foreman/api';
import ForemanPanel from '@/modules/foreman/ForemanPanel';
import { CONFIG, CONFIG_RESPONSE, DECISIONS, INBOX, LESSONS, overview, spend, TASK_DETAIL, TASKS } from '@/modules/foreman/tests/fixtures';

/**
 * The tab as the user meets it: real components, the real English catalog, only the network faked. Each test reads
 * what is on screen, the way the browser check does.
 */

function createBus() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (event: ServerEvent) => act(() => listeners.forEach((listener) => listener(event))),
  };
}

let bus: ReturnType<typeof createBus>;
const Providers = ({ children }: { children: ReactNode }) => (
  <I18nextProvider i18n={i18n}>
    <WebSocketContext.Provider value={{ ws: null, sendMessage: vi.fn(), subscribe: bus.subscribe, isConnected: true }}>{children}</WebSocketContext.Provider>
  </I18nextProvider>
);

/** The Foreman API answers with fixtures; each test overrides what it needs. */
function mockApi() {
  return {
    overview: vi.spyOn(foremanTabApi, 'overview').mockResolvedValue(overview()),
    decisions: vi.spyOn(foremanTabApi, 'decisions').mockResolvedValue(DECISIONS),
    spend: vi.spyOn(foremanTabApi, 'spend').mockImplementation(async (range) => spend(range)),
    agreement: vi.spyOn(foremanTabApi, 'agreement').mockResolvedValue({
      range: '7d',
      overall: { key: 'all', answered: 8, sent: 5, edited: 1, dismissed: 2, acceptanceRate: 0.625, usedRate: 0.75, meanValue: 0.69 },
      byAction: [{ key: 'demand_evidence', answered: 5, sent: 4, edited: 0, dismissed: 1, acceptanceRate: 0.8, usedRate: 0.8, meanValue: 0.8 }],
      byPromptVersion: [],
      byModel: [],
      byEscalation: [],
      statusCounts: { pending: 1 },
    }),
    getConfig: vi.spyOn(foremanTabApi, 'getConfig').mockResolvedValue(CONFIG_RESPONSE),
    putConfig: vi.spyOn(foremanTabApi, 'putConfig').mockResolvedValue(CONFIG_RESPONSE),
    studioLink: vi.spyOn(foremanTabApi, 'studioLink').mockResolvedValue({ traceId: 'a'.repeat(32), url: `http://127.0.0.1:4111/traces?traceId=${'a'.repeat(32)}`, tunnel: 'ssh -N -L 4111:127.0.0.1:4111 nesar@nesar-server', hint: 'Studio is only reachable through an ssh tunnel.' }),
    tasks: vi.spyOn(foremanTabApi, 'tasks').mockResolvedValue(TASKS),
    task: vi.spyOn(foremanTabApi, 'task').mockResolvedValue(TASK_DETAIL),
    takeover: vi.spyOn(foremanTabApi, 'takeover').mockResolvedValue({}),
    kill: vi.spyOn(foremanTabApi, 'kill').mockResolvedValue({ killed: true }),
    resume: vi.spyOn(foremanTabApi, 'resume').mockResolvedValue({ killed: false }),
    inbox: vi.spyOn(foremanTabApi, 'inbox').mockResolvedValue(INBOX),
    answer: vi.spyOn(foremanTabApi, 'answer').mockResolvedValue({}),
    lessons: vi.spyOn(foremanTabApi, 'lessons').mockResolvedValue(LESSONS),
    retireLesson: vi.spyOn(foremanTabApi, 'retireLesson').mockResolvedValue({}),
  };
}

const renderPanel = (props: { isVisible?: boolean; onOpenSession?: (id: string) => void } = {}) =>
  render(<ForemanPanel onOpenSession={props.onOpenSession ?? vi.fn()} isVisible={props.isVisible} />, { wrapper: Providers });

const SECTIONS = { 'Needs you': 'needs', Tasks: 'tasks', 'Live decisions': 'decisions', Spend: 'spend', Lessons: 'lessons', Settings: 'settings' } as const;
const sectionHeader = (name: keyof typeof SECTIONS) => within(screen.getByTestId(`foreman-section-${SECTIONS[name]}`)).getAllByRole('button')[0]!;
const openSection = async (name: keyof typeof SECTIONS) => {
  const button = sectionHeader(name);
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
};

beforeEach(() => {
  localStorage.clear();
  bus = createBus();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('what the tab shows', () => {
  it('renders the status bar and all six sections, and each section shows its data once opened', async () => {
    mockApi();
    renderPanel();
    // status bar
    expect(await screen.findByTestId('foreman-spend-today')).toHaveProperty('textContent', '$1.32 of $25.00');
    expect(screen.getByTestId('foreman-needs-count').textContent).toContain('2');
    expect(screen.getByTestId('foreman-active-count').textContent).toContain('1');
    expect(screen.getByTestId('foreman-agreement').textContent).toContain('63%');
    expect(screen.getByRole('radio', { name: 'Shadow' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: /Stop Foreman/ })).toBeTruthy();

    // all six sections exist, with the three that matter most open
    for (const name of Object.keys(SECTIONS) as Array<keyof typeof SECTIONS>) {
      expect(sectionHeader(name).textContent).toContain(name);
    }
    expect(sectionHeader('Spend').getAttribute('aria-expanded')).toBe('false');
    expect(sectionHeader('Tasks').getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findAllByTestId('foreman-inbox-item')).toHaveLength(2);
    expect(await screen.findAllByTestId('foreman-task')).toHaveLength(2);
    expect(await screen.findAllByTestId('foreman-decision')).toHaveLength(2);

    await openSection('Spend');
    expect(await screen.findByTestId('foreman-spend-foreman-total')).toHaveProperty('textContent', '$0.070');
    expect(screen.getByTestId('foreman-spend-worker-total').textContent).toBe('$1.25');
    expect(screen.getByText('Foreman by role')).toBeTruthy();
    expect(screen.getByText('Workers by task')).toBeTruthy();

    await openSection('Lessons');
    expect(await screen.findAllByTestId('foreman-lesson')).toHaveLength(2);
    expect(screen.getByText('Run pnpm verify before claiming a fix is done.')).toBeTruthy();

    await openSection('Settings');
    expect(await screen.findByTestId('foreman-settings')).toBeTruthy();
    expect((screen.getByLabelText('Per day (USD)') as HTMLInputElement).value).toBe('25');
    expect(screen.getAllByTestId('foreman-role-model')).toHaveLength(6);
    expect((screen.getByLabelText('Path on the server') as HTMLInputElement).value).toBe('/mnt/dev/moveon/desk');
  });

  it('shows no raw translation keys anywhere', async () => {
    mockApi();
    renderPanel();
    await screen.findAllByTestId('foreman-decision');
    await openSection('Spend');
    await openSection('Lessons');
    await openSection('Settings');
    await screen.findByTestId('foreman-settings');
    expect(document.body.textContent).not.toMatch(/\b(status|needs|tasks|decisions|trace|spend|lessons|settings|sections|common)\.[A-Za-z_.]+\b/);
  });

  it('says so when Foreman cannot be reached, and retries', async () => {
    const api = mockApi();
    api.overview.mockRejectedValueOnce(new ApiRequestError('Foreman is not reachable: connect ECONNREFUSED', { code: 'FOREMAN_UNAVAILABLE', status: 502 }));
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Foreman is not reachable');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('foreman-spend-today')).toBeTruthy();
  });

  it('shows the empty states when Foreman has nothing yet', async () => {
    const api = mockApi();
    api.inbox.mockResolvedValue([]);
    api.tasks.mockResolvedValue([]);
    api.decisions.mockResolvedValue([]);
    api.overview.mockResolvedValue(overview({ needsUserCount: 0, activeTasks: 0, agreement7d: null }));
    renderPanel();
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    expect(await screen.findByText('No tasks yet.')).toBeTruthy();
    expect(await screen.findByText('Foreman has not decided anything yet.')).toBeTruthy();
  });
});

describe('the kill switch and the mode', () => {
  it('asks before stopping, does nothing on cancel, stops on confirm and then offers Resume', async () => {
    const api = mockApi();
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Stop Foreman/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Stop everything Foreman is doing?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.kill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Stop Foreman/ }));
    api.overview.mockResolvedValue(overview({ killed: true }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop Foreman' }));
    await waitFor(() => expect(api.kill).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('foreman-killed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resume Foreman/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    api.overview.mockResolvedValue(overview({ killed: false }));
    fireEvent.click(screen.getByRole('button', { name: /Resume Foreman/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('foreman-killed')).toBeNull());
  });

  it('keeps the dialog open and shows the error when the kill fails', async () => {
    const api = mockApi();
    api.kill.mockRejectedValue(new ApiRequestError('Foreman could not do that.', { code: 'FOREMAN_ERROR', status: 502 }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Stop Foreman/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop Foreman' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('could not do that'));
  });

  it('switches the mode only after a confirm', async () => {
    const api = mockApi();
    renderPanel();
    fireEvent.click(await screen.findByRole('radio', { name: 'Autonomous' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Switch to Autonomous mode?');
    expect(api.putConfig).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to Autonomous' }));
    await waitFor(() => expect(api.putConfig).toHaveBeenCalledWith({ mode: 'autonomous' }));
  });
});

describe('needs you', () => {
  it('sends a typed answer to a question and the item leaves the list', async () => {
    const api = mockApi();
    renderPanel();
    const [question] = await screen.findAllByTestId('foreman-inbox-item');
    const send = within(question!).getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(question!).getByLabelText('Your answer'), { target: { value: '  use the local copy ' } });
    api.inbox.mockResolvedValue([INBOX[1]!]);
    api.overview.mockResolvedValue(overview({ needsUserCount: 1 }));
    fireEvent.click(send);
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('inb_q1', { text: 'use the local copy' }));
    await waitFor(() => expect(screen.getAllByTestId('foreman-inbox-item')).toHaveLength(1));
    expect(screen.getByTestId('foreman-needs-count').textContent).toContain('1');
  });

  it('answers a permission with Allow or Deny and an optional reason', async () => {
    const api = mockApi();
    renderPanel();
    const items = await screen.findAllByTestId('foreman-inbox-item');
    const permission = items.find((item) => item.getAttribute('data-kind') === 'permission')!;
    fireEvent.change(within(permission).getByLabelText('Reason (optional)'), { target: { value: 'not on main' } });
    fireEvent.click(within(permission).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('inb_p1', { allow: false, reason: 'not on main' }));
    fireEvent.click(within(permission).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('inb_p1', { allow: true }));
  });

  it('shows an answer that failed and keeps the text', async () => {
    const api = mockApi();
    api.answer.mockRejectedValue(new ApiRequestError('inbox item not found', { code: 'NOT_FOUND', status: 404 }));
    renderPanel();
    const [question] = await screen.findAllByTestId('foreman-inbox-item');
    fireEvent.change(within(question!).getByLabelText('Your answer'), { target: { value: 'staging' } });
    fireEvent.click(within(question!).getByRole('button', { name: 'Send answer' }));
    expect((await within(question!).findByRole('alert')).textContent).toContain('inbox item not found');
    expect((within(question!).getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('staging');
  });

  it('links to the session', async () => {
    mockApi();
    const onOpenSession = vi.fn();
    renderPanel({ onOpenSession });
    const [question] = await screen.findAllByTestId('foreman-inbox-item');
    fireEvent.click(within(question!).getByRole('button', { name: 'Open session' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });

  it('the count in the status bar opens a folded Needs you section', async () => {
    mockApi();
    localStorage.setItem('foreman-tab-sections', JSON.stringify({ needs: false }));
    renderPanel();
    expect(screen.queryByTestId('foreman-inbox-item')).toBeNull();
    fireEvent.click(await screen.findByTestId('foreman-needs-count'));
    expect(await screen.findAllByTestId('foreman-inbox-item')).toHaveLength(2);
  });
});

describe('tasks', () => {
  it('lists tasks with status, repo, cost and last decision, and filters them', async () => {
    mockApi();
    renderPanel();
    const rows = await screen.findAllByTestId('foreman-task');
    expect(rows[0]!.textContent).toContain('Fix the checkout total rounding');
    expect(rows[0]!.textContent).toContain('Running');
    expect(rows[0]!.textContent).toContain('desk');
    expect(rows[0]!.textContent).toContain('$0.420');
    expect(rows[0]!.textContent).toContain('steer: Add a regression test first.');
    fireEvent.click(screen.getByRole('radio', { name: 'Finished' }));
    expect(screen.getAllByTestId('foreman-task')).toHaveLength(1);
    expect(screen.getByTestId('foreman-task').getAttribute('data-status')).toBe('done');
  });

  it('opens a detail view with the definition of done and the timeline, and takes the task over after a confirm', async () => {
    const api = mockApi();
    renderPanel();
    fireEvent.click((await screen.findAllByTestId('foreman-task'))[0]!.querySelector('button')!);
    const detail = await screen.findByTestId('foreman-task-detail');
    const dod = await within(detail).findByTestId('foreman-dod');
    expect(dod.textContent).toContain('pnpm verify passes');
    expect(dod.textContent).toContain('A regression test covers the rounding');
    const timeline = await within(detail).findByTestId('foreman-timeline');
    expect(timeline.textContent).toContain('Steer: add a regression test first.');
    expect(timeline.textContent).toContain('pnpm verify failed on lint.');
    expect(api.task).toHaveBeenCalledWith('task-1');

    fireEvent.click(within(detail).getByRole('button', { name: 'Take over' }));
    expect(api.takeover).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(api.takeover).toHaveBeenCalledWith('task-1'));

    fireEvent.click(within(detail).getByRole('button', { name: /All tasks/ }));
    expect(await screen.findAllByTestId('foreman-task')).toHaveLength(2);
  });
});

describe('live decisions', () => {
  it('shows action, reason, confidence, risk, status and model, and expands to the session and trace links', async () => {
    const api = mockApi();
    const onOpenSession = vi.fn();
    renderPanel({ onOpenSession });
    const rows = await screen.findAllByTestId('foreman-decision');
    expect(rows[0]!.textContent).toContain('Ask for evidence');
    expect(rows[0]!.textContent).toContain('92% sure');
    expect(rows[0]!.textContent).toContain('Low risk');
    expect(rows[0]!.textContent).toContain('Pending');
    expect(rows[0]!.textContent).toContain('api-haiku');
    expect(rows[1]!.textContent).toContain('High risk');
    expect(rows[1]!.textContent).toContain('Dismissed');
    expect(rows[1]!.textContent).toContain('api-sonnet');

    fireEvent.click(rows[0]!.querySelector('button')!);
    expect(rows[0]!.textContent).toContain('Run pnpm verify and paste the output.');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Open session' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-1');

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Trace' }));
    const trace = await within(rows[0]!).findByTestId('foreman-trace');
    expect(api.studioLink).toHaveBeenCalledWith('a'.repeat(32));
    expect(trace.textContent).toContain(`http://127.0.0.1:4111/traces?traceId=${'a'.repeat(32)}`);
    expect(trace.textContent).toContain('ssh -N -L 4111:127.0.0.1:4111');
    expect(trace.textContent).toContain('only reachable through an ssh tunnel');

    // a decision with no trace says so instead of showing a dead button
    fireEvent.click(rows[1]!.querySelector('button')!);
    expect(rows[1]!.textContent).toContain('No trace');
  });

  it('shows the agreement summary and loads more on request', async () => {
    const api = mockApi();
    api.decisions.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({ ...DECISIONS[0]!, id: `sug_${index}` })));
    renderPanel();
    const report = await screen.findByTestId('foreman-agreement-report');
    await waitFor(() => expect(report.textContent).toContain('63% used as they were'));
    expect(report.textContent).toContain('Ask for evidence 80%');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(api.decisions).toHaveBeenLastCalledWith({ limit: 60 }));
  });
});

describe('spend, lessons', () => {
  it('switches the spend range and asks for it', async () => {
    const api = mockApi();
    renderPanel();
    await openSection('Spend');
    await screen.findByTestId('foreman-spend');
    fireEvent.click(within(screen.getByTestId('foreman-section-spend')).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(api.spend).toHaveBeenLastCalledWith('30d'));
    await waitFor(() => expect(screen.getByTestId('foreman-spend').getAttribute('data-range')).toBe('30d'));
  });

  it('retires a lesson after a confirm', async () => {
    const api = mockApi();
    renderPanel();
    await openSection('Lessons');
    const lessons = await screen.findAllByTestId('foreman-lesson');
    fireEvent.click(within(lessons[0]!).getByRole('button', { name: 'Retire' }));
    expect(api.retireLesson).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(api.retireLesson).toHaveBeenCalledWith('les_1'));
  });

  it('shows evidence on request and filters by repo', async () => {
    mockApi();
    renderPanel();
    await openSection('Lessons');
    const lessons = await screen.findAllByTestId('foreman-lesson');
    fireEvent.click(within(lessons[0]!).getByRole('button', { name: /Show evidence \(2\)/ }));
    expect(lessons[0]!.textContent).toContain('task-1 failed lint after a green test run');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'web' } });
    expect(screen.getAllByTestId('foreman-lesson')).toHaveLength(1);
  });
});

describe('settings', () => {
  const openSettings = async () => {
    await openSection('Settings');
    return screen.findByTestId('foreman-settings');
  };

  it('saves only what changed, then says Saved', async () => {
    const api = mockApi();
    renderPanel();
    const form = await openSettings();
    const save = within(form).getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Per day (USD)'), { target: { value: '40' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.putConfig).toHaveBeenCalledWith({ budgets: { perDayUsd: 40 } }));
    expect(await screen.findByTestId('foreman-settings-saved')).toBeTruthy();
  });

  it('shows Foreman\'s field errors beside the fields, saves nothing, and clears an error when the field is edited', async () => {
    const api = mockApi();
    api.putConfig.mockRejectedValueOnce(
      new ApiRequestError('The config is invalid.', {
        code: 'FOREMAN_REJECTED',
        status: 400,
        details: { fieldErrors: { 'budgets.perDayUsd': 'Too small: expected number to be >0', 'repos.0.path': 'Must be an absolute path.', workerBilling: 'Invalid option' } },
      }),
    );
    renderPanel();
    const form = await openSettings();
    fireEvent.change(within(form).getByLabelText('Per day (USD)'), { target: { value: '-5' } });
    fireEvent.change(within(form).getByLabelText('Path on the server'), { target: { value: 'relative' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save settings' }));

    const summary = await screen.findByTestId('foreman-settings-errors');
    expect(summary.textContent).toContain('3 settings need fixing. Nothing was saved.');
    expect(summary.textContent).toContain('workerBilling');
    const perDay = within(form).getByLabelText('Per day (USD)');
    expect(perDay.getAttribute('aria-invalid')).toBe('true');
    expect(form.querySelector('[data-field="budgets.perDayUsd"]')!.textContent).toContain('Too small: expected number to be >0');
    expect(form.querySelector('[data-field="repos.0.path"]')!.textContent).toContain('Must be an absolute path.');
    expect(screen.queryByTestId('foreman-settings-saved')).toBeNull();

    fireEvent.change(perDay, { target: { value: '30' } });
    expect(form.querySelector('[data-field="budgets.perDayUsd"]')!.textContent).not.toContain('Too small');
  });

  it('sends text that is not a number as it is, so Foreman can refuse it', async () => {
    const api = mockApi();
    renderPanel();
    const form = await openSettings();
    fireEvent.change(within(form).getByLabelText('Per day (USD)'), { target: { value: 'lots' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.putConfig).toHaveBeenCalledWith({ budgets: { perDayUsd: 'lots' } }));
  });

  it('edits models per role and repos, and Reset puts everything back', async () => {
    const api = mockApi();
    renderPanel();
    const form = await openSettings();
    const judge = within(form).getAllByTestId('foreman-role-model')[3]!;
    fireEvent.change(within(judge).getByLabelText('Judge model'), { target: { value: 'api-opus' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add repo' }));
    const rows = within(form).getAllByTestId('foreman-repo-row');
    expect(rows).toHaveLength(2);
    fireEvent.change(within(rows[1]!).getByLabelText('Name'), { target: { value: 'web' } });
    fireEvent.change(within(rows[1]!).getByLabelText('Path on the server'), { target: { value: '/srv/web' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(api.putConfig).toHaveBeenCalledWith({
        models: { judge: { model: 'api-opus' } },
        repos: [{ name: 'desk', path: '/mnt/dev/moveon/desk' }, { name: 'web', path: '/srv/web' }],
      }),
    );

    api.putConfig.mockClear();
    fireEvent.change(within(form).getByLabelText('Per day (USD)'), { target: { value: '99' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Reset' }));
    expect((within(form).getByLabelText('Per day (USD)') as HTMLInputElement).value).toBe(String(CONFIG.budgets.perDayUsd));
  });

  it('is not overwritten by the 5-second refresh while the user is typing, and follows the server once it is clean', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    localStorage.setItem('foreman-tab-sections', JSON.stringify({ settings: true }));
    renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const form = screen.getByTestId('foreman-settings');
    const perDay = () => within(form).getByLabelText('Per day (USD)') as HTMLInputElement;
    expect(perDay().value).toBe('25');

    fireEvent.change(perDay(), { target: { value: '77' } });
    api.getConfig.mockResolvedValue({ ...CONFIG_RESPONSE, config: { ...CONFIG, budgets: { perTaskUsd: 3, perDayUsd: 30 } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getConfig.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(perDay().value).toBe('77');

    // Reset drops the edit; the next refresh brings in what the server now has.
    fireEvent.click(within(form).getByRole('button', { name: 'Reset' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(perDay().value).toBe('30');
  });
});

describe('live updates', () => {
  it('polls every 5 seconds while the tab is in front', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.overview).toHaveBeenCalledTimes(1);
    expect(api.decisions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(api.decisions).toHaveBeenCalledTimes(2);
    expect(api.inbox).toHaveBeenCalledTimes(2);
    expect(api.tasks).toHaveBeenCalledTimes(2);
    // a folded section is not polled
    expect(api.spend).not.toHaveBeenCalled();
    expect(api.lessons).not.toHaveBeenCalled();
    expect(api.getConfig).not.toHaveBeenCalled();
  });

  it('does not poll while another tab is in front', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    renderPanel({ isVisible: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.overview).not.toHaveBeenCalled();
    expect(api.decisions).not.toHaveBeenCalled();
  });

  it('refreshes at once when Foreman pushes a suggestion over the WebSocket, and ignores other frames', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.decisions).toHaveBeenCalledTimes(1);

    await bus.emit({ kind: 'session_upserted' });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.decisions).toHaveBeenCalledTimes(1);

    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1' });
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    // two frames in a burst make one refresh
    expect(api.decisions).toHaveBeenCalledTimes(2);
    expect(api.overview).toHaveBeenCalledTimes(2);
  });
});

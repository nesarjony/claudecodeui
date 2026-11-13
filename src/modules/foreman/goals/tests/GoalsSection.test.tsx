import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ApiRequestError } from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { foremanTabApi } from '@/modules/foreman/api';
import ForemanPanel from '@/modules/foreman/ForemanPanel';
import { goalsApi } from '@/modules/foreman/goals/api';
import type { GoalDetail } from '@/modules/foreman/goals/types';
import { CONFIG, CONFIG_RESPONSE, INBOX, overview, TASK_DETAIL, TASKS } from '@/modules/foreman/tests/fixtures';
import {
  DONE_DETAIL,
  GOAL_DONE_ID,
  GOAL_PLAN_ID,
  GOAL_QUESTION_ITEM,
  GOAL_RUNNING_ID,
  GOALS,
  PAUSED_BY_USER,
  PAUSED_ON_BUDGET,
  PAUSED_ON_QUESTION,
  PLAN_DETAIL,
  PLAN_INBOX_ITEM,
  RUNNING_DETAIL,
  TWO_REPO_CONFIG_REPOS,
} from '@/modules/foreman/goals/tests/fixtures';

/**
 * The Goals section as the user meets it: the real panel, components and English catalog, only the network faked.
 */

const Providers = ({ children }: { children: ReactNode }) => (
  <I18nextProvider i18n={i18n}>
    <WebSocketContext.Provider value={{ ws: null, sendMessage: vi.fn(), subscribe: () => () => undefined, isConnected: true }}>{children}</WebSocketContext.Provider>
  </I18nextProvider>
);

const DETAILS: Record<string, GoalDetail> = { [GOAL_PLAN_ID]: PLAN_DETAIL, [GOAL_RUNNING_ID]: RUNNING_DETAIL, [GOAL_DONE_ID]: DONE_DETAIL };

function mockApi(options: { configRepos?: typeof TWO_REPO_CONFIG_REPOS } = {}) {
  const config = options.configRepos ? { ...CONFIG_RESPONSE, config: { ...CONFIG, repos: options.configRepos } } : CONFIG_RESPONSE;
  return {
    overview: vi.spyOn(foremanTabApi, 'overview').mockResolvedValue(overview()),
    decisions: vi.spyOn(foremanTabApi, 'decisions').mockResolvedValue([]),
    agreement: vi.spyOn(foremanTabApi, 'agreement').mockRejectedValue(new Error('not in these tests')),
    getConfig: vi.spyOn(foremanTabApi, 'getConfig').mockResolvedValue(config),
    tasks: vi.spyOn(foremanTabApi, 'tasks').mockResolvedValue(TASKS),
    task: vi.spyOn(foremanTabApi, 'task').mockResolvedValue(TASK_DETAIL),
    inbox: vi.spyOn(foremanTabApi, 'inbox').mockResolvedValue([]),
    answer: vi.spyOn(foremanTabApi, 'answer').mockResolvedValue({}),
    list: vi.spyOn(goalsApi, 'list').mockResolvedValue(GOALS),
    get: vi.spyOn(goalsApi, 'get').mockImplementation(async (id) => DETAILS[id] ?? PLAN_DETAIL),
    create: vi.spyOn(goalsApi, 'create').mockResolvedValue({ ...GOALS[0]!, id: 'goal_new', title: 'Fix checkout', status: 'planning' }),
    approvePlan: vi.spyOn(goalsApi, 'approvePlan').mockResolvedValue(PLAN_DETAIL),
    pause: vi.spyOn(goalsApi, 'pause').mockResolvedValue(PAUSED_BY_USER),
    resume: vi.spyOn(goalsApi, 'resume').mockResolvedValue(RUNNING_DETAIL),
    cancel: vi.spyOn(goalsApi, 'cancel').mockResolvedValue({ ...RUNNING_DETAIL, status: 'cancelled' }),
  };
}

// Only the sections these tests use start open, so the other sections' fetches stay out of the way.
const renderPanel = (open: Record<string, boolean> = { needs: false, tasks: false, goals: true, decisions: false }) => {
  localStorage.setItem('foreman-tab-sections', JSON.stringify(open));
  return render(<ForemanPanel onOpenSession={vi.fn()} />, { wrapper: Providers });
};

const goalsSection = () => screen.getByTestId('foreman-section-goals');
/** A button once it is enabled again (a call in flight disables the controls). */
const enabled = async (container: HTMLElement, name: string) => {
  const button = await within(container).findByRole('button', { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
};
const openGoal = async (title: string) => {
  const card = (await screen.findAllByTestId('foreman-goal')).find((element) => element.textContent?.includes(title))!;
  fireEvent.click(card.querySelector('button')!);
  return screen.findByTestId('foreman-goal-detail');
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the goal list', () => {
  it('sits between Tasks and Live decisions, counts active goals and shows each goal\'s status, progress, spend and next item', async () => {
    mockApi();
    renderPanel();
    const sections = [...document.querySelectorAll('[data-testid^="foreman-section-"]')].map((element) => element.getAttribute('data-testid'));
    expect(sections.indexOf('foreman-section-goals')).toBe(sections.indexOf('foreman-section-tasks') + 1);
    expect(sections.indexOf('foreman-section-decisions')).toBe(sections.indexOf('foreman-section-goals') + 1);

    const cards = await screen.findAllByTestId('foreman-goal');
    expect(cards).toHaveLength(3);
    expect(within(goalsSection()).getAllByRole('button')[0]!.textContent).toContain('2 active');

    const [plan, running, done] = cards;
    expect(plan!.textContent).toContain('Move checkout to the tax service');
    expect(plan!.textContent).toContain('Plan to approve');
    expect(plan!.textContent).toContain('0 of 4 tasks');
    expect(plan!.textContent).toContain('$0.420 of $5.00');
    expect(plan!.textContent).toContain('Next: Waiting for you to approve the plan.');
    expect(plan!.textContent).toContain('web');
    expect(within(plan!).getByTestId('foreman-goal-budget-meter').getAttribute('data-tone')).toBe('neutral');
    expect(plan!.textContent).not.toContain('Overdue');

    expect(running!.textContent).toContain('Running');
    expect(running!.textContent).toContain('2 of 5 tasks');
    expect(running!.textContent).toContain('$4.20 of $5.00');
    expect(running!.textContent).toContain('Next: Write the migration for the tax table');
    expect(running!.textContent).toContain('Overdue');
    expect(within(running!).getByTestId('foreman-goal-budget-meter').getAttribute('data-tone')).toBe('warn');
    expect(within(running!).getByRole('progressbar', { name: 'Tasks done' }).getAttribute('aria-valuenow')).toBe('40');

    expect(done!.textContent).toContain('Done');
    expect(done!.textContent).toContain('$5.50 of $5.00');
    expect(within(done!).getByTestId('foreman-goal-budget-meter').getAttribute('data-tone')).toBe('bad');
    expect(done!.textContent).not.toContain('Next:');
    expect(document.body.textContent).not.toMatch(/\bgoals\.[A-Za-z_.]+/);
  });

  it('shows the empty state, and keeps the last list on screen when a refresh fails', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    api.list.mockResolvedValueOnce([]);
    renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('No goals yet. Give Foreman something big to work on.')).toBeTruthy();
    api.list.mockResolvedValueOnce(GOALS).mockRejectedValueOnce(new ApiRequestError('Foreman is not reachable', { code: 'FOREMAN_UNAVAILABLE', status: 502 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getAllByTestId('foreman-goal')).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(within(goalsSection()).getByRole('alert').textContent).toContain('Foreman is not reachable');
    expect(screen.getAllByTestId('foreman-goal')).toHaveLength(3);
  });
});

describe('the new-goal form', () => {
  const openForm = async () => {
    fireEvent.click(await within(goalsSection()).findByRole('button', { name: 'New goal' }));
    return screen.findByTestId('foreman-goal-form');
  };

  it('checks the form before sending anything and says what to fix', async () => {
    const api = mockApi({ configRepos: TWO_REPO_CONFIG_REPOS });
    renderPanel();
    const form = await openForm();
    await within(form).findByRole('checkbox', { name: 'web' });
    expect((within(form).getByLabelText('Budget (USD)') as HTMLInputElement).value).toBe('5');
    expect((within(form).getByRole('checkbox', { name: 'Ask me to approve the plan first' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.change(within(form).getByLabelText('Budget (USD)'), { target: { value: '0' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create goal' }));
    expect(within(form).getByRole('alert').textContent).toContain('Fix the marked fields first.');
    expect(form.querySelector('[data-field="title"]')!.textContent).toContain('Give the goal a title.');
    expect(form.querySelector('[data-field="description"]')!.textContent).toContain('Describe what should be done.');
    expect(form.querySelector('[data-field="repos"]')!.textContent).toContain('Pick at least one repo.');
    expect(form.querySelector('[data-field="budget"]')!.textContent).toContain('A number above 0 and at most 1000.');
    expect(within(form).getByLabelText('Title').getAttribute('aria-invalid')).toBe('true');
    expect(api.create).not.toHaveBeenCalled();

    // the messages follow the edits
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Fix checkout' } });
    expect(form.querySelector('[data-field="title"]')!.textContent).not.toContain('Give the goal a title.');
    fireEvent.change(within(form).getByLabelText('Budget (USD)'), { target: { value: '1001' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create goal' }));
    expect(api.create).not.toHaveBeenCalled();
  });

  it('sends the goal with the primary repo first, then opens it and clears the form', async () => {
    const api = mockApi({ configRepos: TWO_REPO_CONFIG_REPOS });
    let resolve: (value: Awaited<ReturnType<typeof goalsApi.create>>) => void = () => undefined;
    api.create.mockImplementation(() => new Promise((done) => { resolve = done; }));
    renderPanel();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: '  Fix checkout ' } });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'Totals must round like the tax service.' } });
    fireEvent.click(await within(form).findByRole('checkbox', { name: 'web' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: /desk/ }));
    expect(within(form).getByRole('checkbox', { name: /web/ }).closest('label')!.textContent).toContain('Primary repo');
    fireEvent.change(within(form).getByLabelText('Constraints (optional)'), { target: { value: 'No schema change.' } });
    fireEvent.change(within(form).getByLabelText('Budget (USD)'), { target: { value: '7.5' } });
    fireEvent.change(within(form).getByLabelText('Deadline (optional)'), { target: { value: '2026-12-01T17:00' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Ask me to approve the plan first' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create goal' }));

    expect(api.create).toHaveBeenCalledWith({
      title: 'Fix checkout',
      description: 'Totals must round like the tax service.',
      repos: ['web', 'desk'],
      budgetUsd: 7.5,
      constraints: 'No schema change.',
      deadline: new Date(2026, 11, 1, 17, 0).toISOString(),
      requirePlanApproval: false,
    });
    // busy: no double submit
    expect((within(form).getByRole('button', { name: 'Working...' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolve({ ...GOALS[0]!, id: 'goal_new', title: 'Fix checkout', status: 'planning' }));
    expect(await screen.findByTestId('foreman-goal-detail')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('goal_new');

    fireEvent.click(within(goalsSection()).getByRole('button', { name: /All goals/ }));
    const fresh = await openForm();
    expect((within(fresh).getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect((within(fresh).getByLabelText('Budget (USD)') as HTMLInputElement).value).toBe('5');
  });

  it('picks the only configured repo, and shows Foreman\'s refusal with its issues while keeping the form', async () => {
    const api = mockApi();
    api.create.mockRejectedValue(
      new ApiRequestError('The goal is invalid.', { code: 'FOREMAN_REJECTED', status: 400, details: { issues: [{ path: ['repos', 0], message: 'Unknown repo: desk' }] } }),
    );
    renderPanel();
    const form = await openForm();
    expect((await within(form).findByRole('checkbox', { name: 'desk' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Fix checkout' } });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'All of it.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ title: 'Fix checkout', description: 'All of it.', repos: ['desk'], budgetUsd: 5, requirePlanApproval: true }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('The goal is invalid.');
    expect(alert.textContent).toContain('repos.0: Unknown repo: desk');
    expect((within(form).getByLabelText('Title') as HTMLInputElement).value).toBe('Fix checkout');
    expect((within(form).getByRole('button', { name: 'Create goal' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the draft when the form is folded and unfolded', async () => {
    mockApi();
    renderPanel();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Half typed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('foreman-goal-form')).toBeNull();
    const again = await openForm();
    expect((within(again).getByLabelText('Title') as HTMLInputElement).value).toBe('Half typed');
  });
});

describe('the goal detail', () => {
  it('shows the plan as milestones of dependency-ordered tasks with status chips, fix-ups last, and opens a task', async () => {
    const api = mockApi();
    renderPanel();
    const detail = await openGoal('Upgrade the payment SDK everywhere');
    expect(api.get).toHaveBeenCalledWith(GOAL_RUNNING_ID);
    const plan = await within(detail).findByTestId('foreman-goal-plan');
    expect(plan.textContent).toContain('Bump, then fix the call sites, then run the payment e2e.');
    expect(plan.textContent).toContain('Revision 2');
    expect(plan.textContent).toContain('About $4.00');
    expect(plan.textContent).toContain('Your note: Keep the old webhook endpoint.');

    const milestones = within(plan).getAllByTestId('foreman-goal-milestone');
    expect(milestones.map((element) => element.getAttribute('data-key'))).toEqual(['m1', 'm2', 'fixups']);
    expect(milestones[0]!.textContent).toContain('1. Bump');
    expect(milestones[0]!.textContent).toContain('2 of 2 done');
    expect(milestones[2]!.textContent).toContain('Fix-ups from the judge');
    const rows = within(plan).getAllByTestId('foreman-goal-task');
    expect(rows.map((row) => row.getAttribute('data-key'))).toEqual(['t1', 't2', 't3', 't4', 'f1']);
    expect(rows.map((row) => within(row).getAllByText(/^(Done|Running|Blocked|Ready|Planned)$/)[0]!.textContent)).toEqual(['Done', 'Done', 'Running', 'Blocked', 'Ready']);
    expect(rows[3]!.textContent).toContain('After: Fix the refund call, Fix the webhook handler');
    expect(rows[4]!.textContent).toContain('Fix-up');

    fireEvent.click(rows[0]!.querySelector('button')!);
    const open = within(rows[0]!).getByTestId('foreman-goal-task-detail');
    expect(open.textContent).toContain('The SDK is on v5');
    expect(open.textContent).toContain('package.json pins ^5');
    expect(open.textContent).toContain('pnpm install --frozen-lockfile');
    expect(open.textContent).toContain('$0.300 spent, $0.400 estimated');
    expect(open.textContent).toContain('Bumped to 5.1.0; lockfile updated.');
    expect(open.textContent).toContain('Nothing'); // depends on nothing
    expect(within(open).getByRole('button', { name: 'Trace' })).toBeTruthy();

    fireEvent.click(within(open).getByRole('button', { name: 'Open task' }));
    const task = await screen.findByTestId('foreman-task-detail');
    await waitFor(() => expect(api.task).toHaveBeenCalledWith('task-41'));
    fireEvent.click(within(task).getByRole('button', { name: /Back to the goal/ }));
    expect(await screen.findByTestId('foreman-goal-detail')).toBeTruthy();
  });

  it('a task that never reached the queue has no task link', async () => {
    mockApi();
    renderPanel();
    const detail = await openGoal('Upgrade the payment SDK everywhere');
    const blocked = (await within(detail).findAllByTestId('foreman-goal-task')).find((row) => row.getAttribute('data-key') === 't4')!;
    fireEvent.click(blocked.querySelector('button')!);
    expect(within(blocked).queryByRole('button', { name: 'Open task' })).toBeNull();
    expect(blocked.textContent).toContain('No trace');
  });

  it('shows the judge\'s verdicts and the budget block', async () => {
    mockApi();
    renderPanel();
    const detail = await openGoal('Upgrade the payment SDK everywhere');
    const verdict = await within(detail).findByTestId('foreman-goal-verdict');
    expect(verdict.getAttribute('data-passed')).toBe('false');
    for (const text of ['Run 1', 'Not passed', 'api-sonnet', '$0.120', 'Refunds are not covered by a test.', 'A test covers refunds on v5', 'Add a refund test before judging again.', 'Add the missing refund test']) {
      expect(verdict.textContent).toContain(text);
    }
    expect(within(verdict).getByRole('button', { name: 'Trace' })).toBeTruthy();

    const budget = within(detail).getByTestId('foreman-goal-budget');
    expect(budget.textContent).toContain('80% of the budget used');
    expect(budget.textContent).toContain('$4.20 of $5.00');
    expect(budget.textContent).toContain('Workers$3.00');
    expect(budget.textContent).toContain('Planner and judge$0.400');
    expect(within(budget).getByTestId('foreman-goal-replans').textContent).toBe('1');
    expect(within(budget).getByTestId('foreman-goal-judge-runs').textContent).toBe('1 of 3');

    // a short timeline: the last 8 entries, all on request
    const timeline = within(detail).getByTestId('foreman-goal-timeline');
    expect(timeline.querySelectorAll('li')).toHaveLength(8);
    expect(timeline.textContent).toContain('Step 10 of the goal.');
    expect(timeline.textContent).not.toContain('Step 1 of the goal.');
    fireEvent.click(within(detail).getByRole('button', { name: 'Show all (10)' }));
    expect(within(detail).getByTestId('foreman-goal-timeline').querySelectorAll('li')).toHaveLength(10);
  });

  it('approves the plan, approves it with a note, asks for changes (a note is required) and rejects it after a confirm', async () => {
    const api = mockApi();
    renderPanel();
    const detail = await openGoal('Move checkout to the tax service');
    const card = await within(detail).findByTestId('foreman-goal-approval');
    expect(card.textContent).toContain('4 tasks, about $3.20');
    // the plan is in dependency order before approval too
    expect(within(detail).getAllByTestId('foreman-goal-task').map((row) => row.getAttribute('data-key'))).toEqual(['t1', 't2', 't3', 't4']);
    expect(within(detail).getAllByText('Planned')).toHaveLength(4);

    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenLastCalledWith(GOAL_PLAN_ID, { decision: 'approve' }));

    fireEvent.click(await enabled(card, 'Approve with a note'));
    fireEvent.click(within(card).getByRole('button', { name: 'Approve with this note' }));
    expect(card.textContent).toContain('Write the note, or go back and approve without one.');
    fireEvent.change(within(card).getByLabelText('Note for the workers'), { target: { value: ' keep the old endpoint ' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve with this note' }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenLastCalledWith(GOAL_PLAN_ID, { decision: 'approve', note: 'keep the old endpoint' }));

    fireEvent.click(await enabled(card, 'Ask for changes'));
    fireEvent.click(within(card).getByRole('button', { name: 'Ask for a new plan' }));
    expect(card.textContent).toContain('Say what should change.');
    expect(within(card).getByLabelText('What should change').getAttribute('aria-invalid')).toBe('true');
    expect(api.approvePlan).toHaveBeenCalledTimes(2);
    fireEvent.change(within(card).getByLabelText('What should change'), { target: { value: 'Split the migration into its own milestone.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Ask for a new plan' }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenLastCalledWith(GOAL_PLAN_ID, { decision: 'revise', note: 'Split the migration into its own milestone.' }));

    fireEvent.click(await enabled(card, 'Reject'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Reject this plan?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.approvePlan).toHaveBeenCalledTimes(3);
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject plan' }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenLastCalledWith(GOAL_PLAN_ID, { decision: 'reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows Foreman\'s 409 when the plan was already decided', async () => {
    const api = mockApi();
    api.approvePlan.mockRejectedValue(new ApiRequestError('The goal is not awaiting approval.', { code: 'CONFLICT', status: 409 }));
    renderPanel();
    const card = await within(await openGoal('Move checkout to the tax service')).findByTestId('foreman-goal-approval');
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect((await within(card).findByRole('alert')).textContent).toContain('The goal is not awaiting approval.');
  });

  it('enables Pause, Resume and Cancel per status, and cancels with a reason after a confirm', async () => {
    const api = mockApi();
    renderPanel();
    let detail = await openGoal('Upgrade the payment SDK everywhere');
    const controls = await within(detail).findByTestId('foreman-goal-controls');
    const button = (name: string) => within(controls).getByRole('button', { name }) as HTMLButtonElement;
    expect([button('Pause').disabled, button('Resume').disabled, button('Cancel goal').disabled]).toEqual([false, true, false]);
    expect(within(detail).queryByTestId('foreman-goal-approval')).toBeNull();

    api.get.mockResolvedValue(PAUSED_BY_USER);
    fireEvent.click(button('Pause'));
    await waitFor(() => expect(api.pause).toHaveBeenCalledWith(GOAL_RUNNING_ID));
    await waitFor(() => expect([button('Pause').disabled, button('Resume').disabled]).toEqual([true, false]));
    api.get.mockResolvedValue(RUNNING_DETAIL);
    fireEvent.click(button('Resume'));
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith(GOAL_RUNNING_ID));

    fireEvent.click(await enabled(controls, 'Cancel goal'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('A task already running finishes');
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'not needed any more' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel goal' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(GOAL_RUNNING_ID, 'not needed any more'));

    // an ended goal has no controls
    api.get.mockImplementation(async (id) => DETAILS[id]!);
    fireEvent.click(within(goalsSection()).getByRole('button', { name: /All goals/ }));
    detail = await openGoal('Remove the legacy cart');
    await within(detail).findByTestId('foreman-goal-plan');
    expect(within(detail).queryByTestId('foreman-goal-controls')).toBeNull();
    expect(detail.textContent).toContain('Ended: The judge passed run 2.');
  });

  it('answers a goal question with guidance or fails the goal, and keeps Resume off until then', async () => {
    const api = mockApi();
    api.get.mockResolvedValue(PAUSED_ON_QUESTION);
    renderPanel();
    const detail = await openGoal('Upgrade the payment SDK everywhere');
    const pending = await within(detail).findByTestId('foreman-goal-pending');
    expect(pending.textContent).toContain('Fixing the webhook handler failed twice.');
    expect((within(within(detail).getByTestId('foreman-goal-controls')).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect(detail.textContent).toContain('Paused until you answer above.');

    const send = within(pending).getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(pending).getByLabelText('Your answer'), { target: { value: ' try the v4 shim first ' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith(PAUSED_ON_QUESTION.pending!.inboxId, { text: 'try the v4 shim first' }));

    fireEvent.click(await enabled(pending, 'Fail the goal'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Fail the goal' }));
    await waitFor(() => expect(api.answer).toHaveBeenLastCalledWith(PAUSED_ON_QUESTION.pending!.inboxId, { text: 'fail' }));
  });

  it('extends a spent budget or fails the goal', async () => {
    const api = mockApi();
    api.get.mockResolvedValue(PAUSED_ON_BUDGET);
    renderPanel();
    const detail = await openGoal('Upgrade the payment SDK everywhere');
    const pending = await within(detail).findByTestId('foreman-goal-pending');
    expect(pending.getAttribute('data-kind')).toBe('budget');
    expect(pending.textContent).toContain('$5.10 of $5.00');
    fireEvent.click(within(pending).getByRole('button', { name: 'Extend the budget' }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith(PAUSED_ON_BUDGET.pending!.inboxId, { allow: true }));
    fireEvent.click(await enabled(pending, 'Fail the goal'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Fail the goal' }));
    await waitFor(() => expect(api.answer).toHaveBeenLastCalledWith(PAUSED_ON_BUDGET.pending!.inboxId, { allow: false }));
  });

  it('polls the open goal every 5 seconds and stops when the section is folded', async () => {
    vi.useFakeTimers();
    const api = mockApi();
    renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getAllByTestId('foreman-goal')[1]!.querySelector('button')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.get).toHaveBeenCalledTimes(2);
    fireEvent.click(within(goalsSection()).getAllByRole('button')[0]!);
    const listCalls = api.list.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.list.mock.calls.length).toBe(listCalls);
  });
});

describe('goal items in Needs you', () => {
  it('a plan item has Review plan (opens the goal), Approve and Reject; the option words are not sent as text', async () => {
    const api = mockApi();
    api.inbox.mockResolvedValue([PLAN_INBOX_ITEM, GOAL_QUESTION_ITEM, INBOX[0]!]);
    renderPanel({ needs: true, tasks: false, goals: false, decisions: false });
    const items = await screen.findAllByTestId('foreman-inbox-item');
    const plan = items.find((element) => element.getAttribute('data-kind') === 'plan')!;
    expect(within(plan).getByText('Plan')).toBeTruthy();
    expect(within(plan).queryByRole('button', { name: 'approve' })).toBeNull();
    expect(within(plan).queryByLabelText('Your answer')).toBeNull();

    fireEvent.click(within(plan).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith(PLAN_INBOX_ITEM.id, { allow: true }));
    fireEvent.click(await enabled(plan, 'Reject'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject plan' }));
    await waitFor(() => expect(api.answer).toHaveBeenLastCalledWith(PLAN_INBOX_ITEM.id, { allow: false }));

    // a task's item has no goal link; a goal's question links to the goal
    const taskItem = screen.getAllByTestId('foreman-inbox-item').find((element) => element.textContent?.includes('Which database?'))!;
    expect(within(taskItem).queryByRole('button', { name: 'Open goal' })).toBeNull();
    const question = screen.getAllByTestId('foreman-inbox-item').find((element) => element.textContent?.includes('failed twice'))!;
    fireEvent.click(within(question).getByRole('button', { name: 'continue' }));
    await waitFor(() => expect(api.answer).toHaveBeenLastCalledWith(GOAL_QUESTION_ITEM.id, { text: 'continue' }));
    expect(within(question).getByRole('button', { name: 'Open goal' })).toBeTruthy();

    // Review plan unfolds Goals and opens that goal's detail
    expect(screen.queryByTestId('foreman-goal-detail')).toBeNull();
    fireEvent.click(within(screen.getAllByTestId('foreman-inbox-item').find((element) => element.getAttribute('data-kind') === 'plan')!).getByRole('button', { name: 'Review plan' }));
    const detail = await screen.findByTestId('foreman-goal-detail');
    expect(within(goalsSection()).getAllByRole('button')[0]!.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(GOAL_PLAN_ID));
    expect(await within(detail).findByTestId('foreman-goal-approval')).toBeTruthy();
  });
});

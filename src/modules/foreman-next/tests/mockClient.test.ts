import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '@/shared/api';
import { createMockApi } from '@/modules/foreman-next/api/mock/mockClient';
import { MOCK_SCENARIOS } from '@/modules/foreman-next/api/mock/scenarios';
import { quickApi } from '@/modules/foreman-next/tests/testHelpers';

describe('the mock client, default scenario', () => {
  it('answers a question once: it leaves the inbox, the count drops and the goal is released', async () => {
    const api = quickApi();
    await api.answerQuestion('q-bulk', { optionId: 'A', reply: null, remember: 'repo', delegate: false });
    expect((await api.questions()).map((question) => question.id)).toEqual(['q-realtime']);
    expect((await api.status()).blockingDecisions).toBe(1);
    const inbox = (await api.goals()).goals.find((goal) => goal.id === 'g-inbox');
    expect(inbox?.waitsOnYou).toEqual({ decisions: 1, rowsHeld: 15 });
  });

  it('keeps a veto and an acknowledgement out of the review list', async () => {
    const api = quickApi();
    await api.vetoReviewItem('r-rule', 'too early');
    await api.acknowledgeReviewItem('r-lesson');
    expect((await api.review()).map((item) => item.id)).toEqual(['r-replan', 'r-retry']);
  });

  it('studies a new goal first, with no strategy, and moves on to a strategy that waits for approval', async () => {
    const api = createMockApi({ latencyMs: 0, studyMs: 40 });
    const created = await api.createGoal({ repo: 'desk', goal: 'Reports' });
    const studying = await api.goal(created.id);
    expect(studying).toMatchObject({ state: 'studying', strategy: null, hasStrategy: false });
    expect(studying.study?.map((step) => step.id)).toEqual(['docs', 'conventions', 'checklist', 'git', 'code-map']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const planned = await api.goal(created.id);
    expect(planned).toMatchObject({ state: 'queued', study: null });
    expect(planned.strategy?.status).toBe('awaiting-approval');
    expect((await api.approveStrategy(created.id)).strategy?.status).toBe('approved');
  });

  it('gives the owner questions in the order of rows held, most first, so no client has to sort', async () => {
    const holds = (await quickApi().questions()).map((question) => question.holdsRows);
    expect(holds).toEqual([...holds].sort((first, second) => second - first));
  });

  it('knows each question\'s goal by id, and each history entry\'s', async () => {
    const api = quickApi();
    expect((await api.questions()).every((question) => question.goalId === 'g-inbox')).toBe(true);
    expect((await api.history()).every((entry) => entry.goalId === 'g-inbox')).toBe(true);
  });

  it('keeps one conversation per goal: Foreman maps the subject to its goal and names it', async () => {
    const api = quickApi();
    const byGoal = await api.chatThread({ kind: 'goal', id: 'g-inbox' });
    expect(byGoal).toMatchObject({ goalId: 'g-inbox', label: 'desk · Inbox at 100% Libredesk parity' });
    expect(byGoal.messages.length).toBeGreaterThan(0);
    expect(await api.chatThread({ kind: 'run', id: 'run-t2' })).toMatchObject({ goalId: 'g-inbox', label: 't2-layout', messages: byGoal.messages });
    expect(await api.chatThread({ kind: 'decision', id: 'dec-steer-9' })).toMatchObject({ goalId: 'g-inbox', label: 'Steer at turn 9 · t2-layout' });
    expect(await api.chatThread({ kind: 'general', id: null })).toMatchObject({ goalId: null, label: null, messages: [] });
  });

  it('files a message under the goal of its subject, and remembers an answer', async () => {
    const api = quickApi();
    const general = { kind: 'general', id: null } as const;
    const [, reply] = await api.sendChat({ subject: general, text: 'status?', delivery: 'next-safe-point' });
    expect((await api.chatThread(general)).messages).toHaveLength(2);
    expect((await api.chatThread({ kind: 'goal', id: 'g-inbox' })).messages.some((message) => message.id === reply?.id)).toBe(false);
    await api.sendChat({ subject: { kind: 'run', id: 'run-t2' }, text: 'pause after this', delivery: 'after-batch' });
    expect((await api.chatThread({ kind: 'goal', id: 'g-inbox' })).messages.at(-2)?.text).toBe('pause after this');
    expect((await api.rememberChatMessage(reply?.id ?? '')).remembered).toBe('global');
    expect((await api.rememberChatMessage('m2')).remembered).toBe('goal');
  });

  it('answers the read-only settings, the repos and the alerts behind the strip\'s count', async () => {
    const api = quickApi();
    expect((await api.settings()).roles.map((role) => role.name)).toEqual(['Strategist', 'Supervisor', 'Judge', 'Coach']);
    expect((await api.repos()).map((repo) => repo.name)).toEqual(['desk', 'scratch']);
    expect((await api.alerts()).map((alert) => alert.subject)).toEqual([{ kind: 'run', id: 'run-t2' }]);
    expect((await api.status()).alerts).toBe(1);
  });

  it('refuses to change a locked delegation kind and clears a suggestion the owner accepts', async () => {
    const api = quickApi();
    await expect(api.setDelegation('charter', { level: 'decide-silent', vetoWindowHours: null })).rejects.toMatchObject({ status: 403 });
    const rule = await api.setDelegation('product-scope', { level: 'recommend-wait', vetoWindowHours: null });
    expect(rule.suggestion).toBeNull();
  });

  it('replays a run from a step: earlier stages done, that one running, the rest pending', async () => {
    const run = await quickApi().replayRun('run-t2', 'checks');
    expect(run.stages.map((stage) => stage.state)).toEqual(['done', 'done', 'running', 'pending', 'pending']);
  });

  it('answers a missing record with a 404', async () => {
    await expect(quickApi().decision('nope')).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('the mock client, hand-over (BR-2.10)', () => {
  it('hands an owner session over, lists it as a run, and takes it back', async () => {
    const api = quickApi();
    expect(await api.sessionSupervision('sess-free')).toEqual({ state: 'unsupervised' });
    const run = await api.handOverSession('sess-free', 'finish the import');
    expect(run).toMatchObject({ kind: 'handed-over', goal: 'finish the import', sessionId: 'sess-free' });
    expect(await api.sessionSupervision('sess-free')).toMatchObject({ state: 'handed-over', runId: run.id });
    expect((await api.goals()).handedOver.map((summary) => summary.id)).toContain(run.id);
    expect((await api.today()).running.map((summary) => summary.id)).toContain(run.id);

    const back = await api.takeBackSession('sess-free');
    expect(back.state).toBe('stopped');
    expect(await api.sessionSupervision('sess-free')).toEqual({ state: 'unsupervised' });
  });

  it('does not hand over a worker session or one Foreman already supervises', async () => {
    const api = quickApi();
    expect(await api.sessionSupervision('sess-t2-layout')).toEqual({
      state: 'worker',
      runId: 'run-t2',
      goal: 'desk · Inbox',
      batch: 't2-layout',
      model: 'deepseek-chat',
      sandboxed: true,
      control: 'foreman',
    });
    await expect(api.handOverSession('sess-t2-layout')).rejects.toMatchObject({ status: 409 });
    await expect(api.handOverSession('sess-desk-boss')).rejects.toMatchObject({ status: 409 });
  });

  it('has a handed-over run from the start, so the board and the run view show one', async () => {
    const overview = await quickApi().goals();
    expect(overview.handedOver.map((run) => run.batch)).toEqual(['desk boss']);
  });
});

describe('the mock client, special states', () => {
  it('has a scenario for each state of wireframes §15', () => {
    expect(MOCK_SCENARIOS).toEqual(expect.arrayContaining(['empty', 'quiet', 'budget-paused', 'plan-window-paused', 'deepseek-unread', 'degraded', 'run-failed', 'taken-over', 'error', 'unreachable', 'loading']));
  });

  it('budget-paused: the owner-only question that lifts the pause is there, and cannot be delegated', async () => {
    const questions = await quickApi('budget-paused').questions();
    expect(questions[0]).toMatchObject({ id: 'q-ceiling', delegationKind: 'charter', delegable: false });
    expect(questions.filter((question) => question.delegable)).toHaveLength(2);
  });

  it('taken-over: the worker session reports the owner as driving', async () => {
    expect(await quickApi('taken-over').sessionSupervision('sess-t2-layout')).toMatchObject({ state: 'worker', control: 'owner' });
  });

  it('empty: no goals, nothing to decide', async () => {
    const api = quickApi('empty');
    expect((await api.goals()).goals).toEqual([]);
    expect(await api.questions()).toEqual([]);
    expect((await api.today()).briefing).toBeNull();
  });

  it('unreachable: every call fails but the service log is still served', async () => {
    const api = quickApi('unreachable');
    await expect(api.status()).rejects.toBeInstanceOf(ApiRequestError);
    await expect(api.serviceLog()).resolves.not.toHaveLength(0);
  });

  it('error: reads fail while the status still answers', async () => {
    const api = quickApi('error');
    await expect(api.status()).resolves.toMatchObject({ state: 'running' });
    await expect(api.questions()).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('loading: calls never settle', async () => {
    const outcome = await Promise.race([quickApi('loading').status().then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 30))]);
    expect(outcome).toBe('pending');
  });

  it('run-failed: the run stops at the worker with a reason and the next step', async () => {
    const run = await quickApi('run-failed').run('run-t2');
    expect(run.failure).toMatchObject({ stage: 'worker', next: 'retry' });
    expect(run.stages.find((stage) => stage.id === 'worker')?.state).toBe('failed');
  });
});

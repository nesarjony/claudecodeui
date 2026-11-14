import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '@/shared/api';
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
    expect((await api.review()).map((item) => item.id)).toEqual(['r-replan']);
  });

  it('starts a new goal with a strategy that waits for approval, then approves it', async () => {
    const api = quickApi();
    const created = await api.createGoal({ repo: 'desk', goal: 'Reports' });
    expect((await api.goal(created.id)).strategy?.status).toBe('awaiting-approval');
    expect((await api.approveStrategy(created.id)).strategy?.status).toBe('approved');
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
    expect(await api.sessionSupervision('sess-t2-layout')).toEqual({ state: 'worker' });
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
    expect(MOCK_SCENARIOS).toEqual(expect.arrayContaining(['empty', 'quiet', 'budget-paused', 'minimax-paused', 'degraded', 'run-failed', 'taken-over', 'error', 'unreachable', 'loading']));
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

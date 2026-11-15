import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '@/shared/api';
import { createRealApi } from '@/modules/foreman-next/api/realClient';
import { ENDPOINTS } from '@/modules/foreman-next/api/contract';
import type { ForemanApi } from '@/modules/foreman-next/api/contract';

vi.mock('@/shared/api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, authenticatedFetch: vi.fn() };
});

const respond = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });

type Case = [name: keyof ForemanApi, call: (api: ForemanApi) => Promise<unknown>, method: string, url: string, body?: unknown];

const BASE = '/api/foreman-next';

const CASES: Case[] = [
  ['status', (api) => api.status(), 'GET', `${BASE}/status`],
  ['pauseAll', (api) => api.pauseAll(), 'POST', `${BASE}/status/pause`],
  ['questions', (api) => api.questions(), 'GET', `${BASE}/decide/questions`],
  ['answerQuestion', (api) => api.answerQuestion('q 1', { optionId: 'A', reply: null, remember: 'repo', delegate: false }), 'POST', `${BASE}/decide/questions/q%201/answer`, { optionId: 'A', reply: null, remember: 'repo', delegate: false }],
  ['vetoReviewItem', (api) => api.vetoReviewItem('r1', 'too early'), 'POST', `${BASE}/decide/review/r1/veto`, { reason: 'too early' }],
  ['rateDecision', (api) => api.rateDecision('d1', { verdict: 'bad', correction: 'ask me' }), 'POST', `${BASE}/decisions/d1/feedback`, { verdict: 'bad', correction: 'ask me' }],
  ['createGoal', (api) => api.createGoal({ repo: 'desk', goal: 'Contacts' }), 'POST', `${BASE}/work/goals`, { repo: 'desk', goal: 'Contacts' }],
  ['adjustStrategy', (api) => api.adjustStrategy('g1', 'fewer batches'), 'POST', `${BASE}/work/goals/g1/strategy/adjust`, { note: 'fewer batches' }],
  ['replayRun', (api) => api.replayRun('run-1', 'checks'), 'POST', `${BASE}/work/runs/run-1/replay/checks`],
  ['alerts', (api) => api.alerts(), 'GET', `${BASE}/alerts`],
  ['serviceLog', (api) => api.serviceLog(), 'GET', `${BASE}/service-log`],
  ['repos', (api) => api.repos(), 'GET', `${BASE}/settings/repos`],
  ['setRepo', (api) => api.setRepo('desk', { directory: '/mnt/dev/desk', adapter: 'desk', baseBranch: null }), 'PUT', `${BASE}/settings/repos/desk`, { directory: '/mnt/dev/desk', adapter: 'desk', baseBranch: null }],
  ['setRepoWorkers', (api) => api.setRepoWorkers('desk', true), 'PUT', `${BASE}/settings/repos/desk/workers`, { workers: true }],
  ['settings', (api) => api.settings(), 'GET', `${BASE}/settings`],
  ['chatThread', (api) => api.chatThread({ kind: 'run', id: 'run-1' }), 'GET', `${BASE}/chat/thread?kind=run&id=run-1`],
  ['chatThread', (api) => api.chatThread({ kind: 'general', id: null }), 'GET', `${BASE}/chat/thread?kind=general`],
  ['sendChat', (api) => api.sendChat({ subject: { kind: 'run', id: 'run-1' }, text: 'hi', delivery: 'after-batch' }), 'POST', `${BASE}/chat/messages`, { subject: { kind: 'run', id: 'run-1' }, text: 'hi', delivery: 'after-batch' }],
  ['rememberChatMessage', (api) => api.rememberChatMessage('m 1'), 'POST', `${BASE}/chat/messages/m%201/remember`],
  ['confirmChatProposal', (api) => api.confirmChatProposal('p 1'), 'POST', `${BASE}/chat/proposals/p%201/confirm`],
  ['takeOverRun', (api) => api.takeOverRun('run-1'), 'POST', `${BASE}/work/runs/run-1/take-over`],
  ['stopExperiment', (api) => api.stopExperiment('exp 1'), 'POST', `${BASE}/work/experiments/exp%201/stop`],
  ['sessionSupervision', (api) => api.sessionSupervision('s1'), 'GET', `${BASE}/sessions/s1/supervision`],
  ['handOverSession', (api) => api.handOverSession('s1', 'finish import'), 'POST', `${BASE}/sessions/s1/hand-over`, { goal: 'finish import' }],
  ['handOverSession', (api) => api.handOverSession('s1'), 'POST', `${BASE}/sessions/s1/hand-over`, { goal: null }],
  ['takeBackSession', (api) => api.takeBackSession('s1'), 'POST', `${BASE}/sessions/s1/take-back`],
  ['setDelegation', (api) => api.setDelegation('product-scope', { level: 'decide-tell', vetoWindowHours: 6 }), 'PUT', `${BASE}/settings/delegation/product-scope`, { level: 'decide-tell', vetoWindowHours: 6 }],
];

describe('the real client', () => {
  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => respond({ ok: true }));
  });

  it.each(CASES)('%s calls the endpoint of the contract', async (name, call, method, url, body) => {
    expect(ENDPOINTS[name].method).toBe(method);
    await call(createRealApi());
    // Hand to Foreman is the one call that makes two (the grant, then Foreman's attach): the contract's call is the last.
    const [calledUrl, init] = vi.mocked(authenticatedFetch).mock.calls.at(-1) ?? [];
    expect(calledUrl).toBe(url);
    expect(init?.method).toBe(method);
    expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
  });

  it('records the owner\'s grant in cloudcli before it asks Foreman to attach, and does not ask when the grant is refused', async () => {
    const api = createRealApi();
    await api.handOverSession('s 1', 'finish import');
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/foreman-suggestions/handover/s%201', 'POST'],
      [`${BASE}/sessions/s%201/hand-over`, 'POST'],
    ]);

    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'no' } }), { status: 403 }));
    await expect(api.handOverSession('s1')).rejects.toBeDefined();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(1);
  });

  it('returns the data of the response envelope', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => respond([{ id: 'q1' }]));
    await expect(createRealApi().questions()).resolves.toEqual([{ id: 'q1' }]);
  });

  it('throws the server error of a failed call', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: 'Foreman is down' }), { status: 503 }));
    await expect(createRealApi().status()).rejects.toThrow('Foreman is down');
  });

  it('has a client method for every endpoint of the contract', () => {
    expect(Object.keys(createRealApi()).sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });
});

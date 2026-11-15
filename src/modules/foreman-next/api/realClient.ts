import { authenticatedFetch, readApiJson } from '@/shared/api';
import { ENDPOINTS, FOREMAN_NEXT_API_BASE } from '@/modules/foreman-next/api/contract';
import type { EndpointSpec, ForemanApi } from '@/modules/foreman-next/api/contract';

type Call = { params?: Record<string, string>; query?: Record<string, string | null>; body?: unknown };

function urlOf(endpoint: EndpointSpec, { params = {}, query = {} }: Call): string {
  const path = endpoint.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) search.set(key, value);
  }
  const text = search.toString();
  return `${FOREMAN_NEXT_API_BASE}${path}${text ? `?${text}` : ''}`;
}

async function call<T>(endpoint: EndpointSpec, request: Call = {}): Promise<T> {
  const response = await authenticatedFetch(urlOf(endpoint, request), {
    method: endpoint.method,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const payload = await readApiJson<{ success: true; data: T }>(response);
  return payload.data;
}

/** cloudcli's own route, behind the owner's login: it records the single-use grant that lets Foreman adopt one of the owner's sessions (BR-2.10). */
const HANDOVER_GRANT_PATH = '/api/foreman-suggestions/handover';

/** Hand to Foreman is two steps in this order: the owner's grant is recorded in cloudcli first, since Foreman's attach consumes it, and a refusal here stops before Foreman is asked. */
async function recordHandoverGrant(sessionId: string): Promise<void> {
  await readApiJson(await authenticatedFetch(`${HANDOVER_GRANT_PATH}/${encodeURIComponent(sessionId)}`, { method: 'POST' }));
}

/** Used by loadForemanApi to talk to Foreman's HTTP API through cloudcli's proxy once slice 4b ships it. */
export function createRealApi(): ForemanApi {
  return {
    status: () => call(ENDPOINTS.status),
    pauseAll: () => call(ENDPOINTS.pauseAll),
    resumeAll: () => call(ENDPOINTS.resumeAll),
    stopAll: () => call(ENDPOINTS.stopAll),
    alerts: () => call(ENDPOINTS.alerts),
    serviceLog: () => call(ENDPOINTS.serviceLog),
    today: () => call(ENDPOINTS.today),
    questions: () => call(ENDPOINTS.questions),
    answerQuestion: (id, answer) => call(ENDPOINTS.answerQuestion, { params: { id }, body: answer }),
    review: () => call(ENDPOINTS.review),
    vetoReviewItem: (id, reason) => call(ENDPOINTS.vetoReviewItem, { params: { id }, body: { reason } }),
    acknowledgeReviewItem: (id) => call(ENDPOINTS.acknowledgeReviewItem, { params: { id } }),
    history: () => call(ENDPOINTS.history),
    decision: (id) => call(ENDPOINTS.decision, { params: { id } }),
    rateDecision: (id, feedback) => call(ENDPOINTS.rateDecision, { params: { id }, body: feedback }),
    repos: () => call(ENDPOINTS.repos),
    goals: () => call(ENDPOINTS.goals),
    goal: (id) => call(ENDPOINTS.goal, { params: { id } }),
    createGoal: (request) => call(ENDPOINTS.createGoal, { body: request }),
    approveStrategy: (goalId) => call(ENDPOINTS.approveStrategy, { params: { id: goalId } }),
    adjustStrategy: (goalId, note) => call(ENDPOINTS.adjustStrategy, { params: { id: goalId }, body: { note } }),
    pauseGoal: (goalId) => call(ENDPOINTS.pauseGoal, { params: { id: goalId } }),
    resumeGoal: (goalId) => call(ENDPOINTS.resumeGoal, { params: { id: goalId } }),
    replanGoal: (goalId) => call(ENDPOINTS.replanGoal, { params: { id: goalId } }),
    run: (id) => call(ENDPOINTS.run, { params: { id } }),
    pauseRun: (id) => call(ENDPOINTS.pauseRun, { params: { id } }),
    resumeRun: (id) => call(ENDPOINTS.resumeRun, { params: { id } }),
    stopRun: (id) => call(ENDPOINTS.stopRun, { params: { id } }),
    takeOverRun: (id) => call(ENDPOINTS.takeOverRun, { params: { id } }),
    handBackRun: (id) => call(ENDPOINTS.handBackRun, { params: { id } }),
    replayRun: (id, fromStep) => call(ENDPOINTS.replayRun, { params: { id, step: fromStep } }),
    stopExperiment: (id) => call(ENDPOINTS.stopExperiment, { params: { id } }),
    chatThread: (subject) => call(ENDPOINTS.chatThread, { query: { kind: subject.kind, id: subject.id } }),
    sendChat: (request) => call(ENDPOINTS.sendChat, { body: request }),
    confirmChatProposal: (proposalId) => call(ENDPOINTS.confirmChatProposal, { params: { id: proposalId } }),
    undoChatActions: (actionsId) => call(ENDPOINTS.undoChatActions, { params: { id: actionsId } }),
    rememberChatMessage: (messageId) => call(ENDPOINTS.rememberChatMessage, { params: { id: messageId } }),
    sessionSupervision: (sessionId) => call(ENDPOINTS.sessionSupervision, { params: { id: sessionId } }),
    handOverSession: async (sessionId, goal) => {
      await recordHandoverGrant(sessionId);
      return call(ENDPOINTS.handOverSession, { params: { id: sessionId }, body: { goal: goal ?? null } });
    },
    takeBackSession: (sessionId) => call(ENDPOINTS.takeBackSession, { params: { id: sessionId } }),
    delegation: () => call(ENDPOINTS.delegation),
    setDelegation: (kind, change) => call(ENDPOINTS.setDelegation, { params: { kind }, body: change }),
    attention: () => call(ENDPOINTS.attention),
    setAttention: (policy) => call(ENDPOINTS.setAttention, { body: policy }),
    settings: () => call(ENDPOINTS.settings),
    setRepo: (name, change) => call(ENDPOINTS.setRepo, { params: { name }, body: change }),
    setRepoWorkers: (name, workers) => call(ENDPOINTS.setRepoWorkers, { params: { name }, body: { workers } }),
  };
}

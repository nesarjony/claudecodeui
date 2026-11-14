import { ApiRequestError } from '@/shared/api';
import type {
  ChatMessage,
  DecisionRecord,
  DelegationRule,
  ForemanApi,
  GoalDetail,
  RunDetail,
  RunStageId,
  SessionSupervision,
} from '@/modules/foreman-next/api/contract';
import { clone, find, isLiveHandOver, newGoalDetail, newHandedOverRun, notFound, summaryOf, threadKey } from '@/modules/foreman-next/api/mock/mockHelpers';
import { createMockStore } from '@/modules/foreman-next/api/mock/mockStore';
import type { MockStore } from '@/modules/foreman-next/api/mock/mockStore';
import { applyScenario } from '@/modules/foreman-next/api/mock/scenarios';
import type { MockScenario } from '@/modules/foreman-next/api/mock/scenarios';
import { at, MINUTE_MS } from '@/modules/foreman-next/api/mock/time';

type MockOptions = { scenario?: MockScenario; latencyMs?: number; now?: number };

const STAGE_ORDER: RunStageId[] = ['brief', 'worker', 'checks', 'judge', 'close'];

/**
 * Used by createForemanApi while slice 4b has no endpoints: the whole contract answered from sample data that actions
 * change in memory. The scenario bends the data into one of the special states, so every screen can be seen in each.
 */
export function createMockApi({ scenario = 'default', latencyMs = 150, now = Date.now() }: MockOptions = {}): ForemanApi {
  const store: MockStore = createMockStore(now);
  applyScenario(store, scenario, now);
  let goalCount = 0;
  let messageCount = 0;
  let handOverCount = 0;

  const respond = async <T>(name: keyof ForemanApi, produce: () => T): Promise<T> => {
    if (scenario === 'loading') return new Promise<T>(() => undefined);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const alwaysUp = name === 'serviceLog';
    const failsInError = scenario === 'error' && name !== 'status';
    if (!alwaysUp && (scenario === 'unreachable' || failsInError)) {
      throw new ApiRequestError('Foreman is not responding', { code: 'unreachable', status: 503 });
    }
    return clone(produce());
  };

  const goal = (id: string): GoalDetail => find(store.goals, id, 'goal');
  const run = (id: string): RunDetail => find(store.runs, id, 'run');
  const refreshStatus = (): void => {
    store.status.blockingDecisions = store.questions.length;
  };

  const setRun = (id: string, change: (target: RunDetail) => void): RunDetail => {
    const target = run(id);
    change(target);
    return target;
  };

  const setGoal = (id: string, change: (target: GoalDetail) => void): GoalDetail => {
    const target = goal(id);
    change(target);
    return target;
  };

  const replyTo = (text: string, delivery: string): ChatMessage => ({
    id: `reply-${(messageCount += 1)}`,
    role: 'foreman',
    at: at(Date.now(), 0),
    text:
      delivery === 'after-batch'
        ? `Queued for after this batch: "${text}". I will tell you when it has taken effect.`
        : `Passed on at the next safe point: "${text}". Nothing in the current step is interrupted.`,
    evidence: [],
    actions: null,
  });

  return {
    status: () => respond('status', () => store.status),
    pauseAll: () => respond('pauseAll', () => Object.assign(store.status, { state: 'paused', pauseReason: 'owner' })),
    resumeAll: () => respond('resumeAll', () => Object.assign(store.status, { state: 'running', pauseReason: null, resumesAt: null })),
    stopAll: () => respond('stopAll', () => Object.assign(store.status, { state: 'stopped', pauseReason: 'owner' })),
    serviceLog: () => respond('serviceLog', () => store.serviceLog),
    today: () => respond('today', () => ({ ...store.today, running: [...store.today.running, ...store.runs.filter(isLiveHandOver).map(summaryOf)] })),
    questions: () => respond('questions', () => store.questions),
    answerQuestion: (id, _answer) =>
      respond('answerQuestion', () => {
        const question = find(store.questions, id, 'question');
        store.questions = store.questions.filter((candidate) => candidate.id !== id);
        for (const target of store.goals) {
          for (const batch of target.batches) {
            if (batch.waitsOn?.questionId === id) Object.assign(batch, { state: 'queued', waitsOn: null });
          }
          if (target.name === question.goal.split(' · ')[1]) {
            target.waitsOnYou = {
              decisions: Math.max(0, target.waitsOnYou.decisions - 1),
              rowsHeld: Math.max(0, target.waitsOnYou.rowsHeld - question.holdsRows),
            };
          }
        }
        refreshStatus();
      }),
    review: () => respond('review', () => store.review),
    vetoReviewItem: (id, _reason) =>
      respond('vetoReviewItem', () => {
        find(store.review, id, 'review item');
        store.review = store.review.filter((item) => item.id !== id);
      }),
    acknowledgeReviewItem: (id) =>
      respond('acknowledgeReviewItem', () => {
        find(store.review, id, 'review item');
        store.review = store.review.filter((item) => item.id !== id);
      }),
    history: () => respond('history', () => store.history),
    decision: (id) => respond('decision', () => find(store.decisions, id, 'decision')),
    rateDecision: (id, feedback) =>
      respond('rateDecision', (): DecisionRecord => Object.assign(find(store.decisions, id, 'decision'), { feedback })),
    goals: () => respond('goals', () => ({ programme: store.programme, goals: store.goals, handedOver: store.runs.filter(isLiveHandOver).map(summaryOf) })),
    goal: (id) => respond('goal', () => goal(id)),
    createGoal: (request) =>
      respond('createGoal', () => {
        goalCount += 1;
        const created = newGoalDetail(request, `g-new-${goalCount}`, now);
        store.goals.push(created);
        return created;
      }),
    approveStrategy: (goalId) =>
      respond('approveStrategy', () =>
        setGoal(goalId, (target) => {
          if (target.strategy) target.strategy.status = 'approved';
        }),
      ),
    adjustStrategy: (goalId, note) =>
      respond('adjustStrategy', () =>
        setGoal(goalId, (target) => {
          if (!target.strategy) return;
          target.strategy = { ...target.strategy, version: target.strategy.version + 1, reason: `adjusted: ${note}`, status: 'awaiting-approval' };
        }),
      ),
    pauseGoal: (goalId) => respond('pauseGoal', () => setGoal(goalId, (target) => void (target.state = 'paused'))),
    resumeGoal: (goalId) => respond('resumeGoal', () => setGoal(goalId, (target) => void (target.state = 'active'))),
    replanGoal: (goalId) =>
      respond('replanGoal', () =>
        setGoal(goalId, (target) => {
          if (!target.strategy) return;
          target.strategy = { ...target.strategy, version: target.strategy.version + 1, replannedAt: at(Date.now(), 0), reason: 'because you asked', status: 'in-review' };
        }),
      ),
    run: (id) => respond('run', () => run(id)),
    pauseRun: (id) => respond('pauseRun', () => setRun(id, (target) => void (target.state = 'paused'))),
    resumeRun: (id) => respond('resumeRun', () => setRun(id, (target) => void (target.state = 'running'))),
    stopRun: (id) => respond('stopRun', () => setRun(id, (target) => void (target.state = 'stopped'))),
    takeOverRun: (id) => respond('takeOverRun', () => setRun(id, (target) => void (target.control = 'owner'))),
    handBackRun: (id) => respond('handBackRun', () => setRun(id, (target) => void (target.control = 'foreman'))),
    replayRun: (id, fromStep) =>
      respond('replayRun', () =>
        setRun(id, (target) => {
          const from = STAGE_ORDER.indexOf(fromStep);
          target.state = 'running';
          target.failure = null;
          target.verdict = null;
          target.stages = STAGE_ORDER.map((stage, position) => ({ id: stage, state: position < from ? 'done' : position === from ? 'running' : 'pending' }));
        }),
      ),
    chatThread: (subject) =>
      respond('chatThread', () => ({
        subject: store.subjects.find((candidate) => candidate.kind === subject.kind && candidate.id === subject.id) ?? { ...subject, label: subject.id ?? 'Foreman' },
        subjects: store.subjects,
        messages: store.threads[threadKey(subject)] ?? [],
      })),
    sendChat: ({ subject, text, delivery }) =>
      respond('sendChat', () => {
        const owner: ChatMessage = { id: `owner-${(messageCount += 1)}`, role: 'owner', at: at(Date.now(), 0), text, evidence: [], actions: null };
        const reply = replyTo(text, delivery);
        store.threads[threadKey(subject)] = [...(store.threads[threadKey(subject)] ?? []), owner, reply];
        return [owner, reply];
      }),
    undoChatActions: (actionsId) =>
      respond('undoChatActions', () => {
        const message = Object.values(store.threads)
          .flat()
          .find((candidate) => candidate.actions?.id === actionsId);
        if (!message?.actions) throw notFound('action');
        message.actions.undone = true;
        return message;
      }),
    sessionSupervision: (sessionId) =>
      respond('sessionSupervision', (): SessionSupervision => {
        const handed = store.runs.find((candidate) => isLiveHandOver(candidate) && candidate.sessionId === sessionId);
        if (handed) return { state: 'handed-over', runId: handed.id, goal: handed.goal, since: at(Date.now(), -handed.elapsedMinutes * MINUTE_MS) };
        return { state: store.runs.some((candidate) => candidate.kind === 'worker' && candidate.sessionId === sessionId) ? 'worker' : 'unsupervised' };
      }),
    handOverSession: (sessionId, goal) =>
      respond('handOverSession', (): RunDetail => {
        if (store.runs.some((candidate) => candidate.sessionId === sessionId && (candidate.kind === 'worker' || isLiveHandOver(candidate)))) {
          throw new ApiRequestError('This session is already supervised by Foreman', { code: 'conflict', status: 409 });
        }
        handOverCount += 1;
        const handed = newHandedOverRun(sessionId, goal ?? null, `run-handover-${handOverCount}`);
        store.runs.push(handed);
        return handed;
      }),
    takeBackSession: (sessionId) =>
      respond('takeBackSession', () => {
        const handed = store.runs.find((candidate) => isLiveHandOver(candidate) && candidate.sessionId === sessionId);
        if (!handed) throw notFound('handed-over session');
        Object.assign(handed, { state: 'stopped', control: 'owner' });
        return handed;
      }),
    delegation: () => respond('delegation', () => store.delegation),
    setDelegation: (kind, change) =>
      respond('setDelegation', (): DelegationRule => {
        const rule = store.delegation.find((candidate) => candidate.kind === kind);
        if (!rule) throw notFound('delegation rule');
        if (rule.locked) throw new ApiRequestError('This kind is owner only', { code: 'locked', status: 403 });
        const suggestion = rule.suggestion === change.level ? null : rule.suggestion;
        return Object.assign(rule, change, { suggestion });
      }),
    attention: () => respond('attention', () => store.attention),
    setAttention: (policy) => respond('setAttention', () => Object.assign(store.attention, policy)),
  };
}

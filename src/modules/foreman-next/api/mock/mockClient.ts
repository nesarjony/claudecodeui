import { ApiRequestError } from '@/shared/api';
import type { ChatMessage, ChatSubjectRef, DelegationRule, ForemanApi, GoalDetail, RepoSettings, RunDetail, RunStageId, SessionSupervision } from '@/modules/foreman-next/api/contract';
import { clone, find, firstStrategy, isLiveHandOver, newGoalDetail, newHandedOverRun, notFound, studySteps, summaryOf } from '@/modules/foreman-next/api/mock/mockHelpers';
import { createMockStore } from '@/modules/foreman-next/api/mock/mockStore';
import type { MockStore } from '@/modules/foreman-next/api/mock/mockStore';
import { applyScenario } from '@/modules/foreman-next/api/mock/scenarios';
import type { MockScenario } from '@/modules/foreman-next/api/mock/scenarios';
import { at, MINUTE_MS } from '@/modules/foreman-next/api/mock/time';

type MockOptions = { scenario?: MockScenario; latencyMs?: number; studyMs?: number; now?: number };

const STAGE_ORDER: RunStageId[] = ['brief', 'worker', 'checks', 'judge', 'close'];

/**
 * Used by loadForemanApi while slice 4b has no endpoints: the whole contract answered from sample data that actions
 * change in memory. The scenario bends the data into one of the special states, so every screen can be seen in each.
 */
export function createMockApi({ scenario = 'default', latencyMs = 150, studyMs = 6000, now = Date.now() }: MockOptions = {}): ForemanApi {
  const store: MockStore = createMockStore(now);
  applyScenario(store, scenario, now);
  let goalCount = 0;
  let messageCount = 0;
  let handOverCount = 0;
  const studyEnds = new Map<string, number>();

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

  const advanceStudy = (): void => {
    const current = Date.now();
    for (const [goalId, endsAt] of studyEnds) {
      const target = store.goals.find((candidate) => candidate.id === goalId);
      if (!target) continue;
      if (current >= endsAt) {
        Object.assign(target, { state: 'queued', study: null, hasStrategy: true, strategy: firstStrategy(current) });
        studyEnds.delete(goalId);
      } else {
        target.study = studySteps(1 - (endsAt - current) / studyMs);
      }
    }
  };

  const goal = (id: string): GoalDetail => {
    advanceStudy();
    return find(store.goals, id, 'goal');
  };
  const run = (id: string): RunDetail => find(store.runs, id, 'run');
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
  const findMessage = (predicate: (message: ChatMessage) => boolean): ChatMessage | undefined => Object.values(store.threads).flat().find(predicate);
  const threadOf = (goalId: string | null): ChatMessage[] => store.threads[goalId ?? ''] ?? [];

  const scopeOf = (subject: ChatSubjectRef): { goalId: string | null; label: string | null } => {
    if (subject.id === null) return { goalId: null, label: null };
    if (subject.kind === 'goal') return { goalId: subject.id, label: goal(subject.id).title };
    if (subject.kind === 'run') {
      const target = run(subject.id);
      return { goalId: target.goalId, label: target.batch };
    }
    const decision = find(store.decisions, subject.id, 'decision');
    return { goalId: decision.goalId, label: decision.title };
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
    // A stop cannot be taken back, so chat only proposes it: asking for one puts a button under the reply, and nothing is stopped until it is pressed.
    proposals: /\bstop\b/i.test(text) ? [{ id: `proposal-${messageCount}`, kind: 'stop-run', summary: 'Stop run t2-layout of desk · Inbox', state: 'open' }] : [],
    remembered: null,
  });

  const supervisionOf = (sessionId: string): SessionSupervision => {
    const handed = store.runs.find((candidate) => isLiveHandOver(candidate) && candidate.sessionId === sessionId);
    if (handed) return { state: 'handed-over', runId: handed.id, goal: handed.goal, since: at(Date.now(), -handed.elapsedMinutes * MINUTE_MS) };
    const worker = store.runs.find((candidate) => candidate.kind === 'worker' && candidate.sessionId === sessionId);
    if (!worker) return { state: 'unsupervised' };
    return { state: 'worker', runId: worker.id, goal: worker.goal ?? '', batch: worker.batch, model: worker.model, sandboxed: worker.sandboxed, control: worker.control };
  };

  return {
    status: () => respond('status', () => ({ ...store.status, alerts: store.alerts.length, blockingDecisions: store.questions.length })),
    pauseAll: () => respond('pauseAll', () => Object.assign(store.status, { state: 'paused', pauseReason: 'owner' })),
    resumeAll: () => respond('resumeAll', () => Object.assign(store.status, { state: 'running', pauseReason: null, resumesAt: null })),
    stopAll: () => respond('stopAll', () => Object.assign(store.status, { state: 'stopped', pauseReason: 'owner' })),
    alerts: () => respond('alerts', () => store.alerts),
    serviceLog: () => respond('serviceLog', () => store.serviceLog),
    today: () => respond('today', () => ({ ...store.today, running: [...store.today.running, ...store.runs.filter(isLiveHandOver).map(summaryOf)] })),
    questions: () => respond('questions', () => [...store.questions].sort((first, second) => second.holdsRows - first.holdsRows)),
    answerQuestion: (id) =>
      respond('answerQuestion', () => {
        const question = find(store.questions, id, 'question');
        store.questions = store.questions.filter((candidate) => candidate.id !== id);
        for (const target of store.goals) {
          for (const batch of target.batches) {
            if (batch.waitsOn?.questionId === id) Object.assign(batch, { state: 'queued', waitsOn: null });
          }
          if (target.id === question.goalId) {
            target.waitsOnYou = {
              decisions: Math.max(0, target.waitsOnYou.decisions - 1),
              rowsHeld: Math.max(0, target.waitsOnYou.rowsHeld - question.holdsRows),
            };
          }
        }
      }),
    review: () => respond('review', () => store.review),
    vetoReviewItem: (id) =>
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
    rateDecision: (id, feedback) => respond('rateDecision', () => Object.assign(find(store.decisions, id, 'decision'), { feedback })),
    repos: () => respond('repos', () => store.repos),
    goals: () =>
      respond('goals', () => {
        advanceStudy();
        return { programme: store.programme, goals: store.goals, handedOver: store.runs.filter(isLiveHandOver).map(summaryOf) };
      }),
    goal: (id) => respond('goal', () => goal(id)),
    createGoal: (request) =>
      respond('createGoal', () => {
        goalCount += 1;
        const created = newGoalDetail(request, `g-new-${goalCount}`);
        studyEnds.set(created.id, Date.now() + studyMs);
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
    // The mock has no experiments to stop: every one is unknown, as Foreman says of an id it does not have.
    stopExperiment: () =>
      respond('stopExperiment', () => {
        throw notFound('experiment');
      }),
    chatThread: (subject) =>
      respond('chatThread', () => {
        const scope = scopeOf(subject);
        return { ...scope, goals: store.chatGoals, messages: threadOf(scope.goalId) };
      }),
    sendChat: ({ subject, text, delivery }) =>
      respond('sendChat', () => {
        const { goalId } = scopeOf(subject);
        const owner: ChatMessage = { id: `owner-${(messageCount += 1)}`, role: 'owner', at: at(Date.now(), 0), text, evidence: [], actions: null, proposals: [], remembered: null };
        const reply = replyTo(text, delivery);
        store.threads[goalId ?? ''] = [...threadOf(goalId), owner, reply];
        return [owner, reply];
      }),
    confirmChatProposal: (proposalId) =>
      respond('confirmChatProposal', () => {
        const message = findMessage((candidate) => candidate.proposals.some((proposal) => proposal.id === proposalId));
        const proposal = message?.proposals.find((each) => each.id === proposalId);
        if (!message || !proposal) throw notFound('proposal');
        if (proposal.state === 'confirmed') throw new ApiRequestError('This was already confirmed', { code: 'conflict', status: 409 });
        proposal.state = 'confirmed';
        return message;
      }),
    undoChatActions: (actionsId) =>
      respond('undoChatActions', () => {
        const message = findMessage((candidate) => candidate.actions?.id === actionsId);
        if (!message?.actions) throw notFound('action');
        message.actions.undone = true;
        return message;
      }),
    rememberChatMessage: (messageId) =>
      respond('rememberChatMessage', () => {
        const message = findMessage((candidate) => candidate.id === messageId);
        if (!message) throw notFound('message');
        const inGoalThread = Object.entries(store.threads).some(([goalId, thread]) => goalId !== '' && thread.includes(message));
        message.remembered = inGoalThread ? 'goal' : 'global';
        return message;
      }),
    sessionSupervision: (sessionId) => respond('sessionSupervision', () => supervisionOf(sessionId)),
    handOverSession: (sessionId, goalText) =>
      respond('handOverSession', (): RunDetail => {
        if (store.runs.some((candidate) => candidate.sessionId === sessionId && (candidate.kind === 'worker' || isLiveHandOver(candidate)))) {
          throw new ApiRequestError('This session is already supervised by Foreman', { code: 'conflict', status: 409 });
        }
        handOverCount += 1;
        const handed = newHandedOverRun(sessionId, goalText ?? null, `run-handover-${handOverCount}`);
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
    settings: () => respond('settings', () => store.settings),
    setRepo: (name, change) =>
      respond('setRepo', (): RepoSettings => {
        const known = store.repos.find((candidate) => candidate.name === name);
        if (store.goals.some((goal) => goal.repo === name && goal.state !== 'done')) throw new ApiRequestError('Goals are open on this repo', { code: 'conflict', status: 409 });
        const adapter = change.adapter === 'desk' ? 'read-only' : 'workers';
        const entry: RepoSettings = { ...(known ?? { workers: false, pinned: 0, checks: 'npm test', protectedPaths: 0, indexedAt: null }), name, directory: change.directory, adapter: change.adapter, baseBranch: change.baseBranch ?? 'main', mode: adapter };
        store.repos = known ? store.repos.map((candidate) => (candidate.name === name ? entry : candidate)) : [...store.repos, entry];
        return entry;
      }),
    setRepoWorkers: (name, workers) =>
      respond('setRepoWorkers', () => {
        const target = store.repos.find((candidate) => candidate.name === name);
        if (!target) throw notFound('repo');
        return Object.assign(target, { workers });
      }),
  };
}

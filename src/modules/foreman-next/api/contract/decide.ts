import type { DecisionKind, DelegationKind, DelegationLevel, EntityRef, IsoTime, Maker, RememberScope } from '@/modules/foreman-next/api/contract/foundation';

export type QuestionOption = { id: string; label: string; rowsDelta: number; cost: string; risk: string };
export type SimilarDecision = { id: string; title: string; decidedAt: IsoTime; choice: string };
// `confidence` is null when whoever asked stated none: Foreman shows what it was given, and invents nothing.
export type QuestionRecommendation = { optionId: string; confidence: number | null; reason: string; similar: SimilarDecision[] };

// Foreman orders the list by rows held, most first. `delegable` is false for kinds that never move up the trust ladder, such as the charter's.
export type OwnerQuestion = {
  id: string;
  title: string;
  repo: string;
  goalId: string;
  goal: string;
  delegationKind: DelegationKind | null;
  delegationLevel: DelegationLevel;
  delegable: boolean;
  holdsRows: number;
  askedAt: IsoTime;
  context: string;
  options: QuestionOption[];
  recommendation: QuestionRecommendation | null;
  ifUnanswered: string;
};
export type QuestionAnswer = { optionId: string | null; reply: string | null; remember: RememberScope | null; delegate: boolean };

export const REVIEW_KINDS = ['rule', 'lesson', 'replan', 'delegated-decision'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export type ReviewSubject = EntityRef | { kind: 'rule' | 'lesson'; id: string };
// `closesAt` is null for what only the owner closes: a lesson that needs a worker experiment has no window, and waits for his OK.
export type ReviewItem = { id: string; kind: ReviewKind; subject: ReviewSubject; title: string; evidence: string; detail: string; closesAt: IsoTime | null };

export const HISTORY_DECIDERS = ['owner', 'foreman'] as const;
export type HistoryEntry = {
  id: string;
  title: string;
  goalId: string | null;
  goal: string;
  delegationKind: DelegationKind | null;
  decidedAt: IsoTime;
  decidedBy: (typeof HISTORY_DECIDERS)[number];
  choice: string;
  agreedWithRecommendation: boolean | null;
};

export type DecisionFeedback = { verdict: 'good' } | { verdict: 'bad'; correction: string | null };
export type DecisionRecord = {
  id: string;
  kind: DecisionKind;
  delegationKind: DelegationKind | null;
  title: string;
  goalId: string | null;
  runId: string | null;
  maker: Maker;
  model: string | null;
  costUsd: number;
  durationMs: number;
  traceUrl: string | null;
  saw: string;
  used: string[];
  considered: string[];
  chose: string;
  outcome: string | null;
  feedback: DecisionFeedback | null;
};

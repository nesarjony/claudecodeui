export type IsoTime = string;

// Generated from foreman-next's `src/ledger/kinds.ts`, `src/ledger/decisions.ts` and `src/policy/delegation.ts` by `scripts/sync-contract.ts`; the UI cannot import Foreman's code.
export type DecisionKind =
  | 'routine-turn'
  | 'worker-question'
  | 'worker-done'
  | 'worker-progress'
  | 'worker-error'
  | 'worker-refusal'
  | 'worker-quota'
  | 'silent-session'
  | 'session-resync'
  | 'rework'
  | 'judge'
  | 'integrate'
  | 'guardrail'
  | 'pause'
  | 'alert'
  | 'strategy'
  | 'idle'
  | 'owner-question'
  | 'takeover'
  | 'handback'
  | 'handover'
  | 'release';

export const LEDGER_CHOICES = [
  'continue',
  'steer',
  'answer',
  'ask_owner',
  'stop',
  'fresh_session',
  'pass',
  'fail',
  'integrated',
  'conflict',
  'blocked',
  'pause',
  'pause_batch',
  'take_over',
  'hand_back',
  'hand_over',
  'release',
  'answered',
  'planned',
  'idle',
] as const;
export type LedgerChoice = (typeof LEDGER_CHOICES)[number];

export type Maker = { type: 'code' } | { type: 'owner' } | { type: 'role'; role: 'supervisor' | 'judge' | 'strategist'; version: number };

// The trust ladder (wireframes §11) delegates owner-facing categories, which Foreman classifies; they are coarser than the ledger's kinds.
export const DELEGATION_KINDS = [
  'product-scope',
  'replan-goal',
  'retry-batch',
  'budget-share',
  'worker-setup',
  'charter',
] as const;
export type DelegationKind = (typeof DELEGATION_KINDS)[number];

export const DELEGATION_LEVELS = [
  'ask',
  'recommend-wait',
  'decide-tell',
  'decide-silent',
] as const;
export type DelegationLevel = (typeof DELEGATION_LEVELS)[number];

export const REMEMBER_SCOPES = ['repo', 'goal', 'global'] as const;
export type RememberScope = (typeof REMEMBER_SCOPES)[number];

export const ENTITY_KINDS = ['goal', 'run', 'decision'] as const;
export type EntityRef = { kind: (typeof ENTITY_KINDS)[number]; id: string };

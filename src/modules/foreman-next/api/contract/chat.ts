import type { EntityRef, IsoTime, RememberScope } from '@/modules/foreman-next/api/contract/foundation';

export type ChatSubjectKind = 'general' | 'goal' | 'run' | 'decision';
// What the conversation is about: the screen the owner is on, or a goal they picked. Each goal has one thread.
export type ChatSubjectRef = { kind: ChatSubjectKind; id: string | null };

export const CHAT_DELIVERIES = ['next-safe-point', 'after-batch'] as const;
export type ChatDelivery = (typeof CHAT_DELIVERIES)[number];

export type ChatLink = EntityRef & { label: string };
export type ChatActions = { id: string; count: number; undone: boolean };
// What chat may only propose, because it cannot be taken back (a stop, an answer) or lifts what is not the owner's own pause (a stop, the hold his veto set): the owner confirms it, on a screen or his phone, with the same call his own press makes.
export const CHAT_PROPOSAL_KINDS = ['stop-run', 'answer-question', 'resume'] as const;
export type ChatProposalKind = (typeof CHAT_PROPOSAL_KINDS)[number];
export type ChatProposal = { id: string; kind: ChatProposalKind; summary: string; state: 'open' | 'confirmed' };
export const CHAT_ROLES = ['owner', 'foreman'] as const;
export type ChatMessage = {
  id: string;
  role: (typeof CHAT_ROLES)[number];
  at: IsoTime;
  text: string;
  evidence: ChatLink[];
  actions: ChatActions | null;
  proposals: ChatProposal[];
  remembered: RememberScope | null;
};
export type ChatGoal = { id: string; label: string };
// Foreman maps the subject to the goal whose conversation holds it, and names the subject.
export type ChatThread = { goalId: string | null; label: string | null; goals: ChatGoal[]; messages: ChatMessage[] };
export type ChatSendRequest = { subject: ChatSubjectRef; text: string; delivery: ChatDelivery };

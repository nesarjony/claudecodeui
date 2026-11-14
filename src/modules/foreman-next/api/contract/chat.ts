import type { EntityRef, IsoTime, RememberScope } from '@/modules/foreman-next/api/contract/foundation';

export type ChatSubjectKind = 'general' | 'goal' | 'run' | 'decision';
// What the owner is looking at when they write: it travels with each message as context, while the thread belongs to a goal.
export type ChatSubjectRef = { kind: ChatSubjectKind; id: string | null };

export const CHAT_DELIVERIES = ['next-safe-point', 'after-batch'] as const;
export type ChatDelivery = (typeof CHAT_DELIVERIES)[number];

export type ChatLink = EntityRef & { label: string };
export type ChatActions = { id: string; count: number; undone: boolean };
export const CHAT_ROLES = ['owner', 'foreman'] as const;
export type ChatMessage = {
  id: string;
  role: (typeof CHAT_ROLES)[number];
  at: IsoTime;
  text: string;
  evidence: ChatLink[];
  actions: ChatActions | null;
  remembered: RememberScope | null;
};
export type ChatGoal = { id: string; label: string };
export type ChatThread = { goalId: string | null; goals: ChatGoal[]; messages: ChatMessage[] };
export type ChatSendRequest = { goalId: string | null; subject: ChatSubjectRef; text: string; delivery: ChatDelivery };

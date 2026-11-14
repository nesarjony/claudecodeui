import type { EntityRef, IsoTime, RememberScope } from '@/modules/foreman-next/api/contract/foundation';

export type ChatSubjectKind = 'general' | 'goal' | 'run' | 'decision';
// What the conversation is about: the screen the owner is on, or a goal they picked. Each goal has one thread.
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
// Foreman maps the subject to the goal whose conversation holds it, and names the subject.
export type ChatThread = { goalId: string | null; label: string | null; goals: ChatGoal[]; messages: ChatMessage[] };
export type ChatSendRequest = { subject: ChatSubjectRef; text: string; delivery: ChatDelivery };

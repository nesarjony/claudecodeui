import type { DelegationKind, DelegationLevel, IsoTime } from '@/modules/foreman-next/api/contract/foundation';

export type DelegationRule = {
  kind: DelegationKind;
  level: DelegationLevel;
  vetoWindowHours: number | null;
  agreed: number;
  decided: number;
  suggestion: DelegationLevel | null;
  locked: boolean;
};
export type DelegationChange = { level: DelegationLevel; vetoWindowHours: number | null };

export const ATTENTION_EVENTS = ['blocking-decision', 'idle-decision', 'pause', 'stuck-work', 'decided-alone', 'progress', 'routine'] as const;
export type AttentionEvent = (typeof ATTENTION_EVENTS)[number];
export const ATTENTION_PHONE = ['now', 'delayed', 'never'] as const;
export type AttentionRule = { event: AttentionEvent; phone: (typeof ATTENTION_PHONE)[number]; phoneDelayMinutes: number | null; briefing: boolean };
export type AttentionPolicy = { rules: AttentionRule[]; quietFrom: string; quietTo: string; briefingAt: string };

// The read-only lines of Settings (wireframes §11) besides delegation and attention; the owner edits them in Foreman's own config.
export type ForemanSettings = {
  budget: { monthlyUsd: number; paceUsdPerDay: number; goalShares: { goal: string; usd: number }[] };
  minimax: { stopAtPct: number; autoResume: boolean };
  models: { foremanRoles: string; workers: string; sideRuns: string };
  roles: { name: string; version: number }[];
};
export type RepoSettings = { name: string; checks: string; protectedPaths: number; indexedAt: IsoTime | null };

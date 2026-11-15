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
// The registry of the repos Foreman works on (the Charter's `repos`), as the owner registered them and as each repo's adapter, which is code, says of them.
export type RepoSettings = {
  name: string;
  directory: string;
  adapter: string;
  baseBranch: string;
  /** What the adapter says: a read-only repo (desk) is studied and planned, and gets workers only when the owner turns them on. */
  mode: 'workers' | 'read-only';
  workers: boolean;
  /** The worker-setup files the owner has pinned, which the injection guard does not screen. */
  pinned: number;
  checks: string;
  protectedPaths: number;
  indexedAt: IsoTime | null;
};
/** Adding a repo or changing one: where it is, which adapter reads it, and the branch work is measured from (the one it has checked out when none is named). */
export type RepoChange = { directory: string; adapter: string; baseBranch: string | null };

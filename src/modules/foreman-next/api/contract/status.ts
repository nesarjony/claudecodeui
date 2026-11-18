import type { EntityRef, IsoTime } from '@/modules/foreman-next/api/contract/foundation';

export const DEGRADED_MODES = ['api-credit', 'minimax', 'cloudcli', 'postgres', 'infigraph', 'owner-away', 'claude-cap', 'disk'] as const;
export type DegradedMode = (typeof DEGRADED_MODES)[number];
/** `reason` is said where the loss has one that the owner can act on (infigraph: which repo's code graph, and why it is not there or not open). */
export type DegradedState = { mode: DegradedMode; since: IsoTime; reason?: string };

export const FOREMAN_STATES = ['running', 'paused', 'workers-paused', 'stopped'] as const;
export type ForemanState = (typeof FOREMAN_STATES)[number];

export type ForemanStatus = {
  state: ForemanState;
  pauseReason: 'owner' | 'api-ceiling' | 'minimax-window' | null;
  resumesAt: IsoTime | null;
  /** `monthUsd` is the API credit's, the one the ceiling is about; `deepseekMonthUsd` is Foreman's own DeepSeek calls, paid on their own account and never counted in it; it is `null` when that reading failed. */
  spend: { monthUsd: number; ceilingUsd: number; paceUsdPerDay: number; deepseekMonthUsd: number | null };
  minimax: { fiveHourPct: number; weeklyPct: number };
  alerts: number;
  blockingDecisions: number;
  degraded: DegradedState[];
  studioUrl: string | null;
};

export const ALERT_SEVERITIES = ['warning', 'critical'] as const;
export type AlertItem = { id: string; severity: (typeof ALERT_SEVERITIES)[number]; text: string; at: IsoTime; subject: EntityRef | null };

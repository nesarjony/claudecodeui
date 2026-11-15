import type { EntityRef, IsoTime } from '@/modules/foreman-next/api/contract/foundation';

export const DEGRADED_MODES = ['api-credit', 'minimax', 'cloudcli', 'postgres', 'infigraph', 'owner-away'] as const;
export type DegradedMode = (typeof DEGRADED_MODES)[number];
export type DegradedState = { mode: DegradedMode; since: IsoTime };

export const FOREMAN_STATES = ['running', 'paused', 'workers-paused', 'stopped'] as const;
export type ForemanState = (typeof FOREMAN_STATES)[number];

export type ForemanStatus = {
  state: ForemanState;
  pauseReason: 'owner' | 'api-ceiling' | 'minimax-window' | null;
  resumesAt: IsoTime | null;
  spend: { monthUsd: number; ceilingUsd: number; paceUsdPerDay: number };
  minimax: { fiveHourPct: number; weeklyPct: number };
  alerts: number;
  blockingDecisions: number;
  degraded: DegradedState[];
  studioUrl: string | null;
};

export const ALERT_SEVERITIES = ['warning', 'critical'] as const;
export type AlertItem = { id: string; severity: (typeof ALERT_SEVERITIES)[number]; text: string; at: IsoTime; subject: EntityRef | null };

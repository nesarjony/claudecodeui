import type { ForemanHandoverDependencies } from '@/modules/foreman/foreman-handover.service.js';
import type { createForemanRunModes } from '@/modules/foreman/foreman-run-modes.service.js';

type GrantStore = ForemanHandoverDependencies['grants'];
type GrantRow = Parameters<GrantStore['put']>[0];
type RunModeStore = Parameters<typeof createForemanRunModes>[0]['store'];
type RunModeRow = NonNullable<ReturnType<RunModeStore['get']>>;

/** The grants table in memory, with the repository's rules: a newer grant replaces the older one, and only an unexpired one can be used. */
export function createMemoryGrants(): GrantStore & { rows: Map<string, GrantRow> } {
  const rows = new Map<string, GrantRow>();
  return {
    rows,
    put: (grant) => void rows.set(grant.session_id, { ...grant }),
    consume: (sessionId, nowIso) => {
      const grant = rows.get(sessionId);
      return Boolean(grant && grant.expires_at > nowIso && rows.delete(sessionId));
    },
    revoke: (sessionId) => rows.delete(sessionId),
    purgeExpired: (nowIso) => {
      const expired = [...rows.values()].filter((grant) => grant.expires_at <= nowIso);
      expired.forEach((grant) => rows.delete(grant.session_id));
      return expired.length;
    },
  };
}

/** The run modes table in memory: one row per session, the last record wins. */
export function createMemoryRunModeStore(): RunModeStore & { rows: Map<string, RunModeRow> } {
  const rows = new Map<string, RunModeRow>();
  return {
    rows,
    record: (sessionId, permissionMode, seenAt) => void rows.set(sessionId, { session_id: sessionId, permission_mode: permissionMode, seen_at: seenAt }),
    get: (sessionId) => rows.get(sessionId) ?? null,
  };
}

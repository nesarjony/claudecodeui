import { useTranslation } from 'react-i18next';

import type { ForemanStatus } from '@/modules/foreman-next/api/contract';
import { formatClock, formatDay, formatUsd } from '@/modules/foreman-next/utils/foremanFormat';

function stateKey(status: ForemanStatus): { key: string; values: Record<string, string | number> } {
  const { state, pauseReason, resumesAt, minimax } = status;
  if (state === 'running') return { key: 'running', values: {} };
  if (state === 'stopped') return { key: 'stopped', values: {} };
  if (state === 'workers-paused') {
    return resumesAt ? { key: 'workersPaused', values: { pct: minimax.fiveHourPct, clock: formatClock(resumesAt) } } : { key: 'workersPausedOpen', values: { pct: minimax.fiveHourPct } };
  }
  if (pauseReason === 'api-ceiling') {
    return resumesAt ? { key: 'pausedCeiling', values: { day: formatDay(resumesAt) } } : { key: 'pausedCeilingOpen', values: {} };
  }
  return { key: 'pausedOwner', values: {} };
}

const MARK: Record<ForemanStatus['state'], { mark: string; className: string }> = {
  running: { mark: '●', className: 'text-emerald-600 dark:text-emerald-400' },
  paused: { mark: '◌', className: 'text-amber-600 dark:text-amber-400' },
  'workers-paused': { mark: '◌', className: 'text-amber-600 dark:text-amber-400' },
  stopped: { mark: '■', className: 'text-red-600 dark:text-red-400' },
};

/** Used by the status strip for the run state, the month's API spend, the MiniMax windows and the alert count. */
export function StatusSummary({ status }: { status: ForemanStatus }) {
  const { t } = useTranslation('foremanNext');
  const { mark, className } = MARK[status.state];
  const state = stateKey(status);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <span className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className={className}>
          {mark}
        </span>
        {t(`status.state.${state.key}`, state.values)}
      </span>
      <span className="text-muted-foreground">{t('status.spend', { spent: formatUsd(status.spend.monthUsd), ceiling: formatUsd(status.spend.ceilingUsd) })}</span>
      <span className="text-muted-foreground">{t('status.minimax', { fiveHour: status.minimax.fiveHourPct, weekly: status.minimax.weeklyPct })}</span>
      {status.alerts > 0 ? <span className="font-medium text-amber-700 dark:text-amber-400">{t('status.alerts', { count: status.alerts })}</span> : null}
    </div>
  );
}

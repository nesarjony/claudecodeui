import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ForemanStatus } from '@/modules/foreman-next/api/contract';
import { formatClock, formatDay, formatUsd, formatUsdOrDash } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

function stateKey(status: ForemanStatus): { key: string; values: Record<string, string | number> } {
  const { state, pauseReason, resumesAt } = status;
  if (state === 'running') return { key: 'running', values: {} };
  if (state === 'stopped') return { key: 'stopped', values: {} };
  // The workers' plan window: the contract keeps its `minimax` fields and the `'minimax-window'` reason, but no route has a window now, so the sentence names no gauge and no percentage.
  if (state === 'workers-paused' || pauseReason === 'minimax-window') {
    return resumesAt ? { key: 'workersPaused', values: { clock: formatClock(resumesAt) } } : { key: 'workersPausedOpen', values: {} };
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

/** Used by the status strip for the run state, the month's API credit and DeepSeek spend, and the alert count. */
export function StatusSummary({ status }: { status: ForemanStatus }) {
  const { t } = useTranslation('foremanNext');
  const { mark, className } = MARK[status.state];
  const state = stateKey(status);
  // `deepseekMonthUsd` is `null` when Foreman could not read it, and an older Foreman does not send it: either way there is no number to show.
  const deepseekRead = typeof status.spend.deepseekMonthUsd === 'number' && Number.isFinite(status.spend.deepseekMonthUsd);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <span className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className={className}>
          {mark}
        </span>
        {t(`status.state.${state.key}`, state.values)}
      </span>
      <span className="text-muted-foreground" title={t('status.spendTitle')}>
        {t('status.spend', { spent: formatUsd(status.spend.monthUsd), ceiling: formatUsd(status.spend.ceilingUsd) })}
      </span>
      <span className="text-muted-foreground" title={t(deepseekRead ? 'status.deepseekTitle' : 'status.deepseekUnreadTitle')}>
        {t('status.deepseek', { spent: formatUsdOrDash(status.spend.deepseekMonthUsd) })}
      </span>
      {status.alerts > 0 ? (
        <Link to={foremanPath.alerts} className="font-medium text-amber-700 hover:underline dark:text-amber-400">
          {t('status.alerts', { count: status.alerts })}
        </Link>
      ) : null}
    </div>
  );
}

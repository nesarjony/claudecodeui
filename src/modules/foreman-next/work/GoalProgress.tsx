import { useTranslation } from 'react-i18next';

import type { GoalDetail } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ProgressBar } from '@/modules/foreman-next/components/ProgressBar';
import { formatUsd, formatWeekday } from '@/modules/foreman-next/utils/foremanFormat';

function ForecastLine({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foremanNext');
  const { forecast } = goal;
  if (!forecast) return null;
  const parts = [
    t('work.forecast.batches', { count: forecast.batchesLeft }),
    t('work.forecast.credit', { usd: formatUsd(forecast.usdToGo) }),
    // The estimate of plan windows is the contract's `minimaxWindows`: no route has a window now, so a count of none is not worth a part.
    forecast.minimaxWindows > 0 ? t('work.forecast.windows', { count: forecast.minimaxWindows }) : null,
    forecast.doneBy ? t('work.forecast.doneBy', { day: formatWeekday(forecast.doneBy), certainty: t(`work.certainty.${forecast.certainty}`) }) : null,
  ];
  return (
    <p>
      <span className="font-medium">{t('work.forecast.label')}</span> {parts.filter(Boolean).join(' · ')}
    </p>
  );
}

/** Used by the goal page for rows done, built and to do, the forecast to completion (BR-1.10) and what has been spent against the goal's share. */
export function GoalProgress({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foremanNext');
  const { counts, spent } = goal;
  return (
    <Panel title={t('work.progress')}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium">{t('work.counts.done', { count: counts.done })}</span>
          <ProgressBar
            total={goal.total}
            label={t('work.progressLabel', { done: counts.done, total: goal.total })}
            segments={[
              { value: counts.done, className: 'bg-primary' },
              { value: counts.built, className: 'bg-primary/40' },
            ]}
            className="min-w-40 flex-1"
          />
          <span className="text-muted-foreground">{t('work.counts.built', { count: counts.built })}</span>
          <span className="text-muted-foreground">{t('work.counts.todo', { count: counts.todo })}</span>
        </div>
        <ForecastLine goal={goal} />
        <p>
          <span className="font-medium">{t('work.spent.label')}</span>{' '}
          {t('work.spent.line', { usd: formatUsd(spent.usd), share: formatUsd(spent.shareUsd), yield: spent.firstPassYield, perRow: formatUsd(spent.usdPerRow) })}
        </p>
      </div>
    </Panel>
  );
}

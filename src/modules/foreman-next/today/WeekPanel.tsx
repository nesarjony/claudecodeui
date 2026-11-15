import { useTranslation } from 'react-i18next';

import type { TrendMetric } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { formatUsd } from '@/modules/foreman-next/utils/foremanFormat';

const HIGHER_IS_BETTER: Record<TrendMetric['id'], boolean | null> = {
  'first-pass-yield': true,
  'usd-per-row': false,
  agreed: null,
  'false-stops': null,
};

function TrendValue({ metric }: { metric: TrendMetric }) {
  const { t } = useTranslation('foremanNext');
  if (metric.of !== null) return <>{t('today.agreedOf', { agreed: metric.current, of: metric.of })}</>;
  const show = metric.id === 'first-pass-yield' ? (value: number) => `${value}%` : metric.id === 'usd-per-row' ? formatUsd : String;
  return <>{metric.previous === null ? show(metric.current) : `${show(metric.previous)} → ${show(metric.current)}`}</>;
}

function TrendArrow({ metric }: { metric: TrendMetric }) {
  const higherIsBetter = HIGHER_IS_BETTER[metric.id];
  if (metric.previous === null || higherIsBetter === null || metric.previous === metric.current) return null;
  const up = metric.current > metric.previous;
  const good = up === higherIsBetter;
  return (
    <span aria-hidden className={good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
      {up ? '▲' : '▼'}
    </span>
  );
}

/** Used by the Today screen for the trend that matters this week, including how often the owner agreed with Foreman. */
export function WeekPanel({ trend }: { trend: TrendMetric[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('today.week')}>
      <dl className="space-y-1.5 text-sm">
        {trend.map((metric) => (
          <div key={metric.id} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t(`today.trend.${metric.id}`)}</dt>
            <dd className="tabular-nums">
              <TrendValue metric={metric} /> <TrendArrow metric={metric} />
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

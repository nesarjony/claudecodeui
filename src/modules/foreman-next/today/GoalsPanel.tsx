import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { GoalSummary } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ProgressBar } from '@/modules/foreman-next/components/ProgressBar';
import { formatUsd, formatWeekday } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

function GoalStatus({ goal }: { goal: GoalSummary }) {
  const { t } = useTranslation('foremanNext');
  if (goal.state === 'queued') return <span>○ {goal.queuedAfter ? t('today.queuedAfter', { goal: goal.queuedAfter }) : t('today.queued')}</span>;
  if (goal.state === 'paused') return <span>◌ {t('today.paused')}</span>;
  if (goal.state === 'studying') return <span>◌ {t('work.card.studying')}</span>;
  if (goal.state === 'read-only') return <span>◌ {t('work.card.readOnly', { repo: goal.readOnly?.repo ?? goal.repo })}</span>;
  if (!goal.forecast) return null;
  const { certainty, doneBy, usdToGo } = goal.forecast;
  return (
    <span>
      {certainty === 'likely' ? '●' : '◌'} {t(certainty === 'likely' ? 'today.onTrack' : 'today.mightSlip')}
      {doneBy ? ` · ~${formatWeekday(doneBy)}` : ''} · {t('today.toGo', { usd: formatUsd(usdToGo) })}
    </span>
  );
}

/** Used by the Today screen for each goal still open: progress in the repo's own units, the forecast and what waits on the owner (BR-1.10). */
export function GoalsPanel({ goals }: { goals: GoalSummary[] }) {
  const { t } = useTranslation('foremanNext');
  const open = goals.filter((goal) => goal.state !== 'done');
  return (
    <Panel title={t('today.goals')}>
      <ul className="space-y-3">
        {open.map((goal) => (
          <li key={goal.id} className="grid items-center gap-x-4 gap-y-1 md:grid-cols-[10rem_1fr_6rem_1fr_auto]">
            <Link to={foremanPath.goal(goal.id)} className="truncate text-sm font-medium hover:underline">
              {goal.repo} · {goal.name}
            </Link>
            <ProgressBar total={goal.total} label={t('work.progressLabel', { done: goal.done, total: goal.total })} segments={[{ value: goal.done, className: 'bg-primary' }]} />
            <span className="text-xs tabular-nums text-muted-foreground">
              {goal.done}/{goal.total}
            </span>
            <span className="text-xs text-muted-foreground">
              <GoalStatus goal={goal} />
            </span>
            {goal.waitsOnYou.decisions > 0 ? <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('today.waitOnYou', { count: goal.waitsOnYou.decisions })}</span> : <span />}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

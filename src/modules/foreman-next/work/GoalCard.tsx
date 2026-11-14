import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { GoalSummary } from '@/modules/foreman-next/api/contract';
import type { BoardColumnId } from '@/modules/foreman-next/work/boardColumns';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { formatUsd, formatWeekday } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

function CardLines({ goal, column }: { goal: GoalSummary; column: BoardColumnId }) {
  const { t } = useTranslation('foremanNext');
  const forecast = goal.forecast;
  if (column === 'waiting') {
    return (
      <>
        <p>
          {goal.done}/{goal.total}
          {forecast?.doneBy ? ` · ~${formatWeekday(forecast.doneBy)}` : ''}
        </p>
        <p>{t('work.card.holds', { count: goal.waitsOnYou.decisions, rows: goal.waitsOnYou.rowsHeld })}</p>
      </>
    );
  }
  if (column === 'active') {
    return (
      <>
        <p>{goal.batch ? t('work.card.batch', { current: goal.batch.current, total: goal.batch.total }) : t(`work.state.${goal.state}`)}</p>
        {forecast ? <p>{t('today.toGo', { usd: formatUsd(forecast.usdToGo) })}</p> : null}
      </>
    );
  }
  if (column === 'queued') {
    return (
      <>
        <p>{goal.queuedAfter ? t('today.queuedAfter', { goal: goal.queuedAfter }) : t('today.queued')}</p>
        {goal.hasStrategy ? null : <p>{t('work.card.noStrategy')}</p>}
      </>
    );
  }
  return (
    <>
      <p>
        {goal.done}/{goal.total}
        {goal.daysTaken === null ? '' : ` · ${t('work.card.days', { count: goal.daysTaken })}`}
      </p>
      <p>{formatUsd(goal.spentUsd)}</p>
    </>
  );
}

/** Used by the board and the list view for one goal as the wireframes' card: its name and the two lines that matter for the column it is in. */
export function GoalCard({ goal, column }: { goal: GoalSummary; column: BoardColumnId }) {
  return (
    <Link to={foremanPath.goal(goal.id)} className="block rounded-md border bg-background p-3 text-sm hover:bg-accent/50">
      <div className="mb-1 flex items-center justify-between gap-2 font-medium">
        {goal.repo} · {goal.name}
        {goal.state === 'paused' ? <PausedChip /> : null}
      </div>
      <div className="text-xs text-muted-foreground">
        <CardLines goal={goal} column={column} />
      </div>
    </Link>
  );
}

function PausedChip() {
  const { t } = useTranslation('foremanNext');
  return <Chip tone="warn">{t('work.state.paused')}</Chip>;
}

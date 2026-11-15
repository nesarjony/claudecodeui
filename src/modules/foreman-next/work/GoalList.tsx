import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { GoalsOverview } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { formatUsd } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by the Work screen for the list view: every goal and handed-over session as a row. */
export function GoalList({ overview }: { overview: GoalsOverview }) {
  const { t } = useTranslation('foremanNext');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">{t('work.list.goal')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('work.list.state')}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('work.list.progress')}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('work.list.spent')}</th>
            <th scope="col" className="py-2 pl-3 font-medium">{t('work.list.waiting')}</th>
          </tr>
        </thead>
        <tbody>
          {overview.goals.map((goal) => (
            <tr key={goal.id} className="border-t">
              <th scope="row" className="py-2 pr-3 font-normal">
                <Link to={foremanPath.goal(goal.id)} className="hover:underline">
                  {goal.repo} · {goal.name}
                </Link>
              </th>
              <td className="px-3 py-2">{t(`work.state.${goal.state}`)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{goal.done}/{goal.total}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatUsd(goal.spentUsd)}</td>
              <td className="py-2 pl-3">{goal.waitsOnYou.decisions > 0 ? t('work.card.holds', { count: goal.waitsOnYou.decisions, rows: goal.waitsOnYou.rowsHeld }) : ''}</td>
            </tr>
          ))}
          {overview.handedOver.map((run) => (
            <tr key={run.id} className="border-t">
              <th scope="row" className="py-2 pr-3 font-normal">
                <Link to={foremanPath.run(run.id)} className="hover:underline">
                  {run.batch}
                </Link>
              </th>
              <td className="px-3 py-2">
                <Chip tone="info">{t('work.handedOver')}</Chip>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{t('work.card.handedOverLine', { turn: run.turn ?? 0, minutes: run.elapsedMinutes })}</td>
              <td />
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

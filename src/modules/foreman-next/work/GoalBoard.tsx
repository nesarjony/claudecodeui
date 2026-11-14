import { useTranslation } from 'react-i18next';

import type { GoalsOverview } from '@/modules/foreman-next/api/contract';
import { boardColumns } from '@/modules/foreman-next/work/boardColumns';
import type { BoardColumnId } from '@/modules/foreman-next/work/boardColumns';
import { GoalCard } from '@/modules/foreman-next/work/GoalCard';
import { HandedOverCard } from '@/modules/foreman-next/work/HandedOverCard';

const COLUMNS: BoardColumnId[] = ['waiting', 'active', 'queued', 'done'];

/** Used by the Work screen for the board (wireframes §6a): goals in the columns Waiting on you, Active, Queued and Done, with handed-over sessions among the active work. */
export function GoalBoard({ overview }: { overview: GoalsOverview }) {
  const { t } = useTranslation('foremanNext');
  const columns = boardColumns(overview.goals, overview.handedOver);
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((id) => {
        const handedOver = id === 'active' ? columns.handedOver : [];
        return (
          <section key={id} aria-label={t(`work.column.${id}`)} className="min-w-0 rounded-lg border bg-card p-3">
            <h2 className="mb-3 text-sm font-semibold">{t(`work.column.${id}`)} ({columns[id].length + handedOver.length})</h2>
            <ul className="space-y-2">
              {columns[id].map((goal) => (
                <li key={goal.id}>
                  <GoalCard goal={goal} column={id} />
                </li>
              ))}
              {handedOver.map((run) => (
                <li key={run.id}>
                  <HandedOverCard run={run} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

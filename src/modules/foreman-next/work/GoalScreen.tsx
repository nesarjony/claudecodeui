import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { BatchList } from '@/modules/foreman-next/work/BatchList';
import { GoalHeader } from '@/modules/foreman-next/work/GoalHeader';
import { GoalProgress } from '@/modules/foreman-next/work/GoalProgress';
import { StrategyPanel } from '@/modules/foreman-next/work/StrategyPanel';

const GOAL_POLL_MS = 15_000;

/** Used by ForemanNextRoutes for the goal page (wireframes §6b): progress and forecast, the strategy and its approval, and the batches. */
export function GoalScreen() {
  const { t } = useTranslation('foremanNext');
  const { goalId = '' } = useParams();
  const goal = useForemanResource((api) => api.goal(goalId), { key: goalId, pollMs: GOAL_POLL_MS });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link to={foremanPath.work} className="text-sm text-primary hover:underline">
        ◂ {t('nav.work')}
      </Link>
      <ResourceView resource={goal}>
        {(data) => (
          <>
            <GoalHeader goal={data} onChanged={() => void goal.refresh()} />
            <GoalProgress goal={data} />
            {data.strategy ? <StrategyPanel goalId={data.id} strategy={data.strategy} onChanged={() => void goal.refresh()} /> : null}
            {data.batches.length > 0 ? <BatchList batches={data.batches} /> : null}
          </>
        )}
      </ResourceView>
    </div>
  );
}

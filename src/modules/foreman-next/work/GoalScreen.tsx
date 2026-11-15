import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { BatchList } from '@/modules/foreman-next/work/BatchList';
import { GoalHeader } from '@/modules/foreman-next/work/GoalHeader';
import { GoalProgress } from '@/modules/foreman-next/work/GoalProgress';
import { ReadOnlyPanel } from '@/modules/foreman-next/work/ReadOnlyPanel';
import { StrategyPanel } from '@/modules/foreman-next/work/StrategyPanel';
import { StudyPanel } from '@/modules/foreman-next/work/StudyPanel';

/** Used by ForemanNextRoutes for the goal page (wireframes §6b): what Foreman is studying before a strategy exists, then progress and forecast, the strategy and its approval, and the batches. */
export function GoalScreen() {
  const { t } = useTranslation('foremanNext');
  const { goalId = '' } = useParams();
  const [params] = useSearchParams();
  const goal = useForemanResource((api) => api.goal(goalId), { key: goalId, keepPolling: (data) => data.state !== 'done' });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link to={foremanPath.work} className="text-sm text-primary hover:underline">
        ◂ {t('nav.work')}
      </Link>
      <ResourceView resource={goal}>
        {(data) => (
          <>
            <GoalHeader goal={data} />
            {data.study ? <StudyPanel steps={data.study} /> : <GoalProgress goal={data} />}
            {data.readOnly || data.repoProgress.length > 0 ? <ReadOnlyPanel goal={data} /> : null}
            {data.strategy ? <StrategyPanel goalId={data.id} strategy={data.strategy} compareOnOpen={params.get('compare') === 'previous'} /> : null}
            {data.batches.length > 0 ? <BatchList batches={data.batches} /> : null}
          </>
        )}
      </ResourceView>
    </div>
  );
}

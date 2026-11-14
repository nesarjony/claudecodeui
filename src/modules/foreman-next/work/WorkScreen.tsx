import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { GoalBoard } from '@/modules/foreman-next/work/GoalBoard';
import { GoalList } from '@/modules/foreman-next/work/GoalList';
import { NewGoalDialog } from '@/modules/foreman-next/work/NewGoalDialog';
import { NoGoalsState } from '@/modules/foreman-next/work/NoGoalsState';
import { Button } from '@/shared/ui';

const VIEWS = ['board', 'list'] as const;
const WORK_POLL_MS = 15_000;

/** Used by ForemanNextRoutes for Work (wireframes §6a): the programme, the New goal action and the goals as a board or a list. */
export function WorkScreen() {
  const { t } = useTranslation('foremanNext');
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'list' ? 'list' : 'board';
  const goals = useForemanResource((api) => api.goals(), { pollMs: WORK_POLL_MS });
  // Whether the New goal dialog is open.
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h1 className="sr-only">{t('nav.work')}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-2.5">
        <p className="text-sm">{goals.data?.programme ? t('work.programme', { name: goals.data.programme }) : t('nav.work')}</p>
        <div className="flex items-center gap-4">
          <fieldset className="flex items-center gap-3 text-sm">
            <legend className="sr-only">{t('work.view')}</legend>
            <span aria-hidden className="text-muted-foreground">
              {t('work.view')}
            </span>
            {VIEWS.map((option) => (
              <label key={option} className="flex items-center gap-1.5">
                <input type="radio" name="work-view" checked={view === option} onChange={() => setParams(option === 'board' ? {} : { view: option })} />
                {t(`work.views.${option}`)}
              </label>
            ))}
          </fieldset>
          <Button size="sm" onClick={() => setCreating(true)}>
            + {t('work.newGoal')}
          </Button>
        </div>
      </div>
      <ResourceView resource={goals} isEmpty={(overview) => overview.goals.length === 0 && overview.handedOver.length === 0} empty={<NoGoalsState />}>
        {(overview) => (view === 'board' ? <GoalBoard overview={overview} /> : <GoalList overview={overview} />)}
      </ResourceView>
      {creating ? <NewGoalDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

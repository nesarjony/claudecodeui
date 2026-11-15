import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { BriefingPanel } from '@/modules/foreman-next/today/BriefingPanel';
import { GoalsPanel } from '@/modules/foreman-next/today/GoalsPanel';
import { NeedsYouPanel } from '@/modules/foreman-next/today/NeedsYouPanel';
import { ReviewPanel } from '@/modules/foreman-next/today/ReviewPanel';
import { RunningNowPanel } from '@/modules/foreman-next/today/RunningNowPanel';
import { WeekPanel } from '@/modules/foreman-next/today/WeekPanel';
import { NoGoalsState } from '@/modules/foreman-next/work/NoGoalsState';

/** Used by ForemanNextRoutes for Today (wireframes §4): the briefing first, then only what is actionable, then the state of work. */
export function TodayScreen() {
  const { t } = useTranslation('foremanNext');
  const goals = useForemanResource((api) => api.goals());
  const today = useForemanResource((api) => api.today());
  const questions = useForemanResource((api) => api.questions());
  const review = useForemanResource((api) => api.review());
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="sr-only">{t('nav.today')}</h1>
      <ResourceView resource={goals} isEmpty={(overview) => overview.goals.length === 0} empty={<NoGoalsState />}>
        {(overview) => (
          <ResourceView resource={today}>
            {(snapshot) => (
              <>
                <BriefingPanel briefing={snapshot.briefing} />
                <div className="grid gap-4 md:grid-cols-2">
                  <NeedsYouPanel questions={questions} />
                  <ReviewPanel review={review} />
                </div>
                <GoalsPanel goals={overview.goals} />
                <div className="grid gap-4 md:grid-cols-2">
                  <RunningNowPanel running={snapshot.running} />
                  <WeekPanel trend={snapshot.trend} />
                </div>
              </>
            )}
          </ResourceView>
        )}
      </ResourceView>
    </div>
  );
}

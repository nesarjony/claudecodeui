import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { NothingNeedsYou } from '@/modules/foreman-next/decide/NothingNeedsYou';
import { QuestionCard } from '@/modules/foreman-next/decide/QuestionCard';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by ForemanNextRoutes for Decide > Needs you: every decision that blocks work, in the order Foreman gives them (most rows held first), or just the one a link points at. */
export function NeedsYouTab() {
  const { t } = useTranslation('foremanNext');
  const { questionId } = useParams();
  const questions = useForemanResource((api) => api.questions());
  const today = useForemanResource((api) => api.today());
  const batch = today.data?.running[0]?.batch;

  return (
    <ResourceView resource={questions} isEmpty={(items) => items.length === 0} empty={<NothingNeedsYou batch={batch} />}>
      {(items) => {
        const shown = questionId ? items.filter((question) => question.id === questionId) : items;
        return (
          <div className="space-y-4">
            {questionId && shown.length > 0 ? (
              <Link to={foremanPath.needsYou()} className="text-sm text-primary hover:underline">
                ◂ {t('decide.allQuestions')}
              </Link>
            ) : null}
            {shown.length === 0 ? <NothingNeedsYou batch={batch} /> : shown.map((question) => <QuestionCard key={question.id} question={question} />)}
          </div>
        );
      }}
    </ResourceView>
  );
}

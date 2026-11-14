import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { NothingNeedsYou } from '@/modules/foreman-next/decide/NothingNeedsYou';
import { QuestionCard } from '@/modules/foreman-next/decide/QuestionCard';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { useRefreshStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by ForemanNextRoutes for Decide > Needs you: every decision that blocks work, the ones holding the most rows first, or just the one a link points at. */
export function NeedsYouTab() {
  const { t } = useTranslation('foremanNext');
  const { questionId } = useParams();
  const refreshStatus = useRefreshStatus();
  const questions = useForemanResource((api) => api.questions());

  const answered = () => {
    void questions.refresh();
    void refreshStatus();
  };

  return (
    <ResourceView resource={questions} isEmpty={(items) => items.length === 0} empty={<NothingNeedsYou />}>
      {(items) => {
        const shown = questionId ? items.filter((question) => question.id === questionId) : [...items].sort((first, second) => second.holdsRows - first.holdsRows);
        return (
          <div className="space-y-4">
            {questionId && shown.length > 0 ? (
              <Link to={foremanPath.needsYou()} className="text-sm text-primary hover:underline">
                ◂ {t('decide.allQuestions')}
              </Link>
            ) : null}
            {shown.length === 0 ? <NothingNeedsYou /> : shown.map((question) => <QuestionCard key={question.id} question={question} onAnswered={answered} />)}
          </div>
        );
      }}
    </ResourceView>
  );
}

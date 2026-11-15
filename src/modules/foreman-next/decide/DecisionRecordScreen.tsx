import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { DecisionRecordCard } from '@/modules/foreman-next/decide/DecisionRecordCard';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by ForemanNextRoutes for the decision card page, opened from a run, from History or from a chat answer. */
export function DecisionRecordScreen() {
  const { t } = useTranslation('foremanNext');
  const { decisionId = '' } = useParams();
  const record = useForemanResource((api) => api.decision(decisionId), { key: decisionId });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="sr-only">{t('record.screen')}</h1>
      <ResourceView resource={record}>
        {(data) => (
          <>
            <Link to={data.runId ? foremanPath.run(data.runId) : foremanPath.history} className="text-sm text-primary hover:underline">
              ◂ {t(data.runId ? 'record.backToRun' : 'record.back')}
            </Link>
            <DecisionRecordCard record={data} />
          </>
        )}
      </ResourceView>
    </div>
  );
}

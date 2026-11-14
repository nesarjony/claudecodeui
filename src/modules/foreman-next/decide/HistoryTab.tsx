import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Chip } from '@/modules/foreman-next/components/Chip';
import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { formatDay } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by ForemanNextRoutes for Decide > History: past decisions, by the owner or by Foreman, each opening its decision card. */
export function HistoryTab() {
  const { t } = useTranslation('foremanNext');
  const history = useForemanResource((api) => api.history());
  return (
    <ResourceView resource={history} isEmpty={(entries) => entries.length === 0} empty={<EmptyState title={t('history.none')} />}>
      {(entries) => (
        <ul className="divide-y rounded-lg border bg-card px-4">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
              <div className="min-w-0">
                <Link to={foremanPath.decision(entry.id)} className="text-sm font-medium hover:underline">
                  {entry.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {entry.goal} · {formatDay(entry.decidedAt)} · {entry.choice}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {entry.delegationKind ? <Chip>{t(`delegation.kind.${entry.delegationKind}`)}</Chip> : null}
                <Chip>{t(`history.by.${entry.decidedBy}`)}</Chip>
                {entry.agreedWithRecommendation === null ? null : (
                  <Chip tone={entry.agreedWithRecommendation ? 'good' : 'warn'}>{t(entry.agreedWithRecommendation ? 'history.agreed' : 'history.differed')}</Chip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </ResourceView>
  );
}

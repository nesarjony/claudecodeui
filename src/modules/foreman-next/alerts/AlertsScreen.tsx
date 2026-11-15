import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { AlertItem } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';
import { entityPath } from '@/modules/foreman-next/utils/foremanPaths';

function AlertLine({ alert }: { alert: AlertItem }) {
  const { t } = useTranslation('foremanNext');
  const { subject } = alert;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{alert.text}</p>
        <p className="text-xs text-muted-foreground">{formatClock(alert.at)}</p>
      </div>
      <div className="flex items-center gap-3">
        <Chip tone={alert.severity === 'critical' ? 'bad' : 'warn'}>{t(`alerts.severity.${alert.severity}`)}</Chip>
        {subject ? (
          <Link to={entityPath(subject)} className="text-sm text-primary hover:underline">
            {t(`alerts.open.${subject.kind}`)} ↗
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** Used by ForemanNextRoutes for the alerts behind the status strip's count: what needs a look, with a link to the goal, run or decision it is about. */
export function AlertsScreen() {
  const { t } = useTranslation('foremanNext');
  const alerts = useForemanResource((api) => api.alerts());
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">{t('alerts.title')}</h1>
      <ResourceView resource={alerts} isEmpty={(items) => items.length === 0} empty={<EmptyState title={t('alerts.none')} />}>
        {(items) => (
          <ul className="divide-y rounded-lg border bg-card px-4">
            {items.map((alert) => (
              <AlertLine key={alert.id} alert={alert} />
            ))}
          </ul>
        )}
      </ResourceView>
    </div>
  );
}

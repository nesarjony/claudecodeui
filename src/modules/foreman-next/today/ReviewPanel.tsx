import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { VetoCountdown } from '@/modules/foreman-next/components/VetoCountdown';
import { ReviewAcknowledgeButton } from '@/modules/foreman-next/decide/ReviewAcknowledgeButton';
import { ReviewInspectLink } from '@/modules/foreman-next/decide/ReviewInspectLink';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by the Today screen to list what Foreman decided alone, each with its veto window, and to acknowledge it in one tap. */
export function ReviewPanel({ review }: { review: Resource<ReviewItem[]> }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel
      title={t('today.review')}
      aside={
        <Link to={foremanPath.review} className="text-primary hover:underline">
          {t('today.details')}
        </Link>
      }
    >
      <ResourceView resource={review} isEmpty={(items) => items.length === 0} empty={<p className="text-sm text-muted-foreground">{t('today.reviewNone')}</p>}>
        {(items) => (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">{item.title}</p>
                  <div className="flex shrink-0 items-center gap-1">
                    <ReviewInspectLink item={item} />
                    <ReviewAcknowledgeButton item={item} labelKey="today.looksRight" />
                  </div>
                </div>
                <p className="text-xs">
                  <VetoCountdown closesAt={item.closesAt} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
    </Panel>
  );
}

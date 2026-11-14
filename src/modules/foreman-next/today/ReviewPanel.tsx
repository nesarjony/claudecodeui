import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { VetoCountdown } from '@/modules/foreman-next/components/VetoCountdown';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { useRefreshStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

function ReviewLine({ item, onAcknowledged }: { item: ReviewItem; onAcknowledged: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const acknowledge = async () => {
    if (await run(() => api.acknowledgeReviewItem(item.id))) onAcknowledged();
  };
  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{item.title}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void acknowledge()}>
          {t('today.looksRight')}
        </Button>
      </div>
      <p className="text-xs">
        <VetoCountdown closesAt={item.closesAt} />
      </p>
      {failed ? <InlineError /> : null}
    </li>
  );
}

/** Used by the Today screen to list what Foreman decided alone, each with its veto window, and to acknowledge it in one tap. */
export function ReviewPanel() {
  const { t } = useTranslation('foremanNext');
  const refreshStatus = useRefreshStatus();
  const review = useForemanResource((api) => api.review());
  const acknowledged = () => {
    void review.refresh();
    void refreshStatus();
  };
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
              <ReviewLine key={item.id} item={item} onAcknowledged={acknowledged} />
            ))}
          </ul>
        )}
      </ResourceView>
    </Panel>
  );
}

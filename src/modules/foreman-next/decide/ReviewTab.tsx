import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { ReviewRow } from '@/modules/foreman-next/decide/ReviewRow';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by ForemanNextRoutes for Decide > Review (wireframes §5b): everything Foreman decided alone, open to veto until its window closes (BR-4.8). `?item=` opens one row with its details shown, as Today's link does. */
export function ReviewTab() {
  const { t } = useTranslation('foremanNext');
  const review = useForemanResource((api) => api.review());
  const [params] = useSearchParams();
  const named = params.get('item');
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('review.intro')}</p>
      <ResourceView resource={review} isEmpty={(items) => items.length === 0} empty={<EmptyState title={t('review.none')} />}>
        {(items) => (
          <ul className="divide-y rounded-lg border bg-card px-4">
            {items.map((item) => (
              <ReviewRow key={item.id} item={item} startOpen={item.id === named} />
            ))}
          </ul>
        )}
      </ResourceView>
      <p className="text-xs text-muted-foreground">{t('review.footer')}</p>
    </section>
  );
}

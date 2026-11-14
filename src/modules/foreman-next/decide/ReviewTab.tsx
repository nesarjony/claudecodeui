import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { ReviewRow } from '@/modules/foreman-next/decide/ReviewRow';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by ForemanNextRoutes for Decide > Review (wireframes §5b): everything Foreman decided alone, open to veto until its window closes (BR-4.8). */
export function ReviewTab() {
  const { t } = useTranslation('foremanNext');
  const review = useForemanResource((api) => api.review());
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('review.intro')}</p>
      <ResourceView resource={review} isEmpty={(items) => items.length === 0} empty={<EmptyState title={t('review.none')} />}>
        {(items) => (
          <ul className="divide-y rounded-lg border bg-card px-4">
            {items.map((item) => (
              <ReviewRow key={item.id} item={item} onSettled={() => void review.refresh()} />
            ))}
          </ul>
        )}
      </ResourceView>
      <p className="text-xs text-muted-foreground">{t('review.footer')}</p>
    </section>
  );
}

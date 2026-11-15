import { useTranslation } from 'react-i18next';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

/** Used by the Review tab (OK) and the Today review panel (Looks right): the owner accepts what Foreman decided alone, which closes its veto window early. `disabled` is for what he has not read yet. */
export function ReviewAcknowledgeButton({ item, labelKey, disabled = false }: { item: ReviewItem; labelKey: 'review.ok' | 'today.looksRight'; disabled?: boolean }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => void run(() => api.acknowledgeReviewItem(item.id))}>
        {t(labelKey)}
      </Button>
      {failed ? <InlineError /> : null}
    </>
  );
}

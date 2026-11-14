import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { VetoCountdown } from '@/modules/foreman-next/components/VetoCountdown';
import { ReviewAcknowledgeButton } from '@/modules/foreman-next/decide/ReviewAcknowledgeButton';
import { ReviewInspectLink } from '@/modules/foreman-next/decide/ReviewInspectLink';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Input } from '@/shared/ui';

/** Used by the Review tab for one thing Foreman decided alone: its evidence, how long the owner can still veto it, and OK, Veto (with the reason that becomes a lesson), Details or the page it is about. */
export function ReviewRow({ item }: { item: ReviewItem }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // Whether the change itself is shown under the row.
  const [showDetail, setShowDetail] = useState(false);
  // Whether the veto reason field is open, and what has been typed; a veto records why, so it cannot be one click.
  const [vetoing, setVetoing] = useState(false);
  const [reason, setReason] = useState('');

  const confirmVeto = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.vetoReviewItem(item.id, reason.trim()));
  };

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            <span aria-hidden className="mr-1.5 text-amber-600">
              ●
            </span>
            {item.title}
          </p>
          <p className="text-xs text-muted-foreground">{item.evidence}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <VetoCountdown closesAt={item.closesAt} />
          <ReviewInspectLink item={item} />
          <Button variant="ghost" size="sm" aria-expanded={showDetail} onClick={() => setShowDetail((open) => !open)}>
            {t('review.details')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setVetoing(true)}>
            {t('review.veto')}
          </Button>
          <ReviewAcknowledgeButton item={item} labelKey="review.ok" />
        </div>
      </div>
      {showDetail ? <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{item.detail}</p> : null}
      {vetoing ? (
        <form onSubmit={confirmVeto} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`veto-${item.id}`} className="text-sm">
            {t('review.vetoReason')}
          </label>
          <Input id={`veto-${item.id}`} value={reason} onChange={(event) => setReason(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" variant="destructive" size="sm" disabled={busy || reason.trim() === ''}>
            {t('review.confirmVeto')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setVetoing(false)}>
            {t('common.cancel')}
          </Button>
        </form>
      ) : null}
      {failed ? <InlineError /> : null}
    </li>
  );
}

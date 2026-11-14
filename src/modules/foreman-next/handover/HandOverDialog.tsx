import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

type HandOverDialogProps = { sessionId: string; onClose: () => void; onHandedOver: () => void };

/** Used by the session bar to hand one of the owner's own sessions to Foreman (BR-2.10): an optional goal, then a confirmation. */
export function HandOverDialog({ sessionId, onClose, onHandedOver }: HandOverDialogProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // What the owner wants done with the session; empty means "take this over" and is sent as no goal.
  const [goal, setGoal] = useState('');

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.handOverSession(sessionId, goal.trim() || undefined))) {
      onHandedOver();
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5">
        <form onSubmit={(event) => void confirm(event)} className="space-y-4">
          <DialogTitle className="not-sr-only text-base font-semibold">{t('handover.title')}</DialogTitle>
          <div className="space-y-1">
            <label htmlFor="hand-over-goal" className="text-sm font-medium">
              {t('handover.goalLabel')}
            </label>
            <Input id="hand-over-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('handover.goalPlaceholder')} />
            <p className="text-xs text-muted-foreground">{t('handover.hint')}</p>
          </div>
          {failed ? <InlineError /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {t('handover.confirm')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type StopAllDialogProps = { busy: boolean; onConfirm: () => void; onClose: () => void };

/** Used by the status strip to confirm "Stop all", the one control that halts every worker. */
export function StopAllDialog({ busy, onConfirm, onClose }: StopAllDialogProps) {
  const { t } = useTranslation('foremanNext');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="space-y-4 p-5">
        <DialogTitle className="not-sr-only text-base font-semibold">{t('status.stopTitle')}</DialogTitle>
        <p className="text-sm text-muted-foreground">{t('status.stopBody')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
            {t('status.stopConfirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

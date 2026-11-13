import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { errorMessage } from '@/modules/foreman/api';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** The label of the button that closes without acting (default "Cancel"). */
  cancelLabel?: string;
  /** `danger` paints the confirm button red (kill switch). */
  tone?: 'default' | 'danger';
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  /** Extra fields under the description (an optional reason). */
  children?: ReactNode;
};

/**
 * Asks before doing something that matters (stop everything, change the mode, take a task over, retire a lesson).
 * The action runs inside the dialog: it stays open and shows the error if the call fails, and closes when it works.
 * Mount it only while it is wanted (its busy and error state starts fresh each time).
 */
export default function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, tone = 'default', onConfirm, onCancel, children }: ConfirmDialogProps) {
  const { t } = useTranslation('foreman');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(errorMessage(failure, t('common.failed')));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md space-y-3 p-4">
        <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        <p className="break-words text-sm text-muted-foreground">{description}</p>
        {children}
        {error && (
          <p role="alert" className="break-words rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" className="h-11 sm:h-10" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'destructive' : 'default'} className="h-11 sm:h-10" onClick={() => void confirm()} disabled={busy}>
            {busy ? t('common.working') : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

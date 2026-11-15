import { useTranslation } from 'react-i18next';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

/** Used by the connection banner to show Foreman's service log, which cloudcli serves even while Foreman is down. */
export function ServiceLogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('foremanNext');
  const log = useForemanResource((api) => api.serviceLog());
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl space-y-3 p-5">
        <DialogTitle className="not-sr-only text-base font-semibold">{t('connection.logTitle')}</DialogTitle>
        <div className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3">
          <ResourceView resource={log} isEmpty={(lines) => lines.length === 0} empty={<p className="text-sm text-muted-foreground">{t('connection.logEmpty')}</p>}>
            {(lines) => <pre className="whitespace-pre-wrap font-mono text-xs">{lines.join('\n')}</pre>}
          </ResourceView>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

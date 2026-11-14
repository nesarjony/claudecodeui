import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { useForemanStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { useOnline } from '@/modules/foreman-next/hooks/useOnline';
import { ServiceLogDialog } from '@/modules/foreman-next/shell/ServiceLogDialog';
import { Button } from '@/shared/ui';

function Banner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-red-500/10 px-4 py-2 text-sm">
      {children}
    </div>
  );
}

/** Used by ForemanShell to say, above every screen, that the network is gone or that Foreman is not answering (wireframes §15). */
export function ConnectionBanner() {
  const { t } = useTranslation('foremanNext');
  const { status, refresh } = useForemanStatus();
  const online = useOnline();
  // Whether the service log dialog is open; the log is only fetched when the owner asks for it.
  const [logOpen, setLogOpen] = useState(false);

  if (!online) return <Banner>{t('connection.offline')}</Banner>;
  if (status !== 'error') return null;
  return (
    <Banner>
      <span className="min-w-0 flex-1">{t('connection.unreachable')}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t('common.retry')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
          {t('connection.serviceLog')}
        </Button>
      </div>
      {logOpen ? <ServiceLogDialog onClose={() => setLogOpen(false)} /> : null}
    </Banner>
  );
}

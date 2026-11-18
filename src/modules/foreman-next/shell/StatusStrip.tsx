import { useTranslation } from 'react-i18next';
import type { Ref } from 'react';

import { useForemanStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { DegradedModes } from '@/modules/foreman-next/shell/DegradedModes';
import { StatusControls } from '@/modules/foreman-next/shell/StatusControls';
import { StatusSummary } from '@/modules/foreman-next/shell/StatusSummary';

type StatusStripProps = { chatOpen: boolean; chatButtonRef: Ref<HTMLButtonElement>; onToggleChat: () => void };

/** Used by ForemanShell as the strip on every screen: run state, API credit and DeepSeek spend, alerts, global controls and every degraded mode. */
export function StatusStrip({ chatOpen, chatButtonRef, onToggleChat }: StatusStripProps) {
  const { t } = useTranslation('foremanNext');
  const { data: status, status: loadState } = useForemanStatus();
  return (
    <header aria-label={t('status.label')} className="shrink-0 border-b bg-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 text-sm">
        {status ? (
          <StatusSummary status={status} />
        ) : (
          <span className="text-muted-foreground">{loadState === 'error' ? t('status.unknown') : t('status.connecting')}</span>
        )}
        <StatusControls status={status} chatOpen={chatOpen} chatButtonRef={chatButtonRef} onToggleChat={onToggleChat} />
      </div>
      {status && status.degraded.length > 0 ? <DegradedModes modes={status.degraded} /> : null}
    </header>
  );
}

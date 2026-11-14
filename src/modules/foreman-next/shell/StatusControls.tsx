import { useState } from 'react';
import { MessageSquare, OctagonX, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Ref } from 'react';

import type { ForemanStatus } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { StopAllDialog } from '@/modules/foreman-next/modals/StopAllDialog';
import { Button } from '@/shared/ui';

type StatusControlsProps = {
  status: ForemanStatus | null;
  chatOpen: boolean;
  chatButtonRef: Ref<HTMLButtonElement>;
  onToggleChat: () => void;
};

/** Used by the status strip for Pause all, Resume all, Stop all and the chat drawer toggle. */
export function StatusControls({ status, chatOpen, chatButtonRef, onToggleChat }: StatusControlsProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // Whether the "Stop all" confirmation is showing; stopping every worker is never one click.
  const [confirmingStop, setConfirmingStop] = useState(false);

  const canResume = status !== null && (status.state === 'stopped' || status.pauseReason === 'owner');
  const canPause = status !== null && (status.state === 'running' || status.state === 'workers-paused');

  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {failed ? <InlineError /> : null}
      {canResume ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => api.resumeAll())}>
          <Play /> {t('status.resumeAll')}
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={busy || !canPause} onClick={() => void run(() => api.pauseAll())}>
          <Pause /> {t('status.pauseAll')}
        </Button>
      )}
      <Button variant="outline" size="sm" disabled={busy || status === null || status.state === 'stopped'} onClick={() => setConfirmingStop(true)}>
        <OctagonX /> {t('status.stopAll')}
      </Button>
      <Button
        ref={chatButtonRef}
        variant={chatOpen ? 'default' : 'outline'}
        size="sm"
        aria-expanded={chatOpen}
        aria-controls="foreman-chat-drawer"
        aria-keyshortcuts="Meta+J Control+J"
        onClick={onToggleChat}
      >
        <MessageSquare /> {t('status.chat')} <kbd className="text-[11px] opacity-70">⌘J</kbd>
      </Button>
      {confirmingStop ? (
        <StopAllDialog
          busy={busy}
          onClose={() => setConfirmingStop(false)}
          onConfirm={() => void run(() => api.stopAll()).then(() => setConfirmingStop(false))}
        />
      ) : null}
    </div>
  );
}

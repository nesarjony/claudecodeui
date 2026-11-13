import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ScrollText } from 'lucide-react';

import { errorMessage, foremanTabApi } from '@/modules/foreman/api';
import type { StudioLink } from '@/modules/foreman/types';

type Phase = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; link: StudioLink } | { status: 'error'; message: string };

/**
 * A "Trace" button. Studio listens on loopback and is reached through an ssh tunnel, so a plain link would be dead on a
 * phone: the button asks for the link and shows the URL (to copy), the tunnel command and the hint instead.
 */
export default function TraceLink({ traceId }: { traceId: string }) {
  const { t } = useTranslation('foreman');
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [copied, setCopied] = useState<string | null>(null);

  const toggle = async () => {
    if (phase.status === 'ready' || phase.status === 'error') {
      setPhase({ status: 'idle' });
      return;
    }
    setPhase({ status: 'loading' });
    try {
      setPhase({ status: 'ready', link: await foremanTabApi.studioLink(traceId) });
    } catch (error) {
      setPhase({ status: 'error', message: errorMessage(error, t('common.failed')) });
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((current) => (current === value ? null : current)), 1500);
    } catch {
      // Clipboard is blocked (insecure origin): the text is selectable on screen anyway.
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={phase.status === 'ready' || phase.status === 'error'}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted"
      >
        <ScrollText className="h-3.5 w-3.5" aria-hidden />
        {phase.status === 'loading' ? t('common.loading') : t('trace.button')}
      </button>
      {(phase.status === 'ready' || phase.status === 'error') && (
        <div data-testid="foreman-trace" className="basis-full space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-2 text-xs">
          {phase.status === 'error' ? (
            <p role="alert" className="break-words text-red-700 dark:text-red-400">
              {phase.message}
            </p>
          ) : (
            <>
              {[
                { label: t('trace.url'), value: phase.link.url },
                { label: t('trace.tunnel'), value: phase.link.tunnel },
              ].map((row) => (
                <div key={row.label} className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground/80">{row.label}</span>
                    <button
                      type="button"
                      onClick={() => void copy(row.value)}
                      aria-label={t('trace.copy', { what: row.label })}
                      className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground"
                    >
                      {copied === row.value ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      {copied === row.value ? t('trace.copied') : t('trace.copyShort')}
                    </button>
                  </div>
                  <code className="block select-all break-all rounded bg-background/70 px-1.5 py-1 font-mono text-[11px] text-foreground">{row.value}</code>
                </div>
              ))}
              <p className="break-words text-muted-foreground">{phase.link.hint}</p>
            </>
          )}
        </div>
      )}
    </>
  );
}

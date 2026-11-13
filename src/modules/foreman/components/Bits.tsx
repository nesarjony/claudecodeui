import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '@/modules/foreman/api';
import { formatAgo } from '@/modules/foreman/format';
import { useNow } from '@/modules/foreman/useNow';

/** Opens the chat of a session. */
export function SessionLink({ sessionId, onOpen }: { sessionId: string; onOpen: (sessionId: string) => void }) {
  const { t } = useTranslation('foreman');
  return (
    <button
      type="button"
      onClick={() => onOpen(sessionId)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted"
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      {t('common.openSession')}
    </button>
  );
}

/** A failed load, with a retry. Shown next to whatever was last loaded. */
export function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation('foreman');
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 break-words rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-400">
      <span className="min-w-0 flex-1">{errorMessage(error, t('common.loadFailed'))}</span>
      <button type="button" onClick={onRetry} className="min-h-8 rounded-md border border-red-500/40 px-2 font-medium">
        {t('common.retry')}
      </button>
    </div>
  );
}

export function Empty({ children }: { children: string }) {
  return <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">{children}</p>;
}

export function Loading() {
  const { t } = useTranslation('foreman');
  return <p className="py-2 text-center text-xs text-muted-foreground">{t('common.loading')}</p>;
}

/** "3 min. ago", in the UI language, kept current. */
export function Ago({ iso, className = 'text-[11px] text-muted-foreground' }: { iso: string | undefined | null; className?: string }) {
  const { i18n } = useTranslation('foreman');
  const now = useNow();
  const text = formatAgo(iso, now, i18n.language);
  return text ? <span className={className}>{text}</span> : null;
}

import { useTranslation } from 'react-i18next';

import type { IsoTime } from '@/modules/foreman-next/api/contract';
import { useNow } from '@/shared/hooks/useNow';
import { formatClock, formatRemaining } from '@/modules/foreman-next/utils/foremanFormat';
import { cn } from '@/shared/utils';

const TICK_MS = 30_000;
const URGENT_MS = 60 * 60_000;

/** Used by the Review tab and the Today review panel to show how long the owner can still veto something Foreman decided alone. */
export function VetoCountdown({ closesAt }: { closesAt: IsoTime }) {
  const { t } = useTranslation('foremanNext');
  const now = useNow(TICK_MS);
  const remaining = new Date(closesAt).getTime() - now;
  if (remaining <= 0) return <span className="text-muted-foreground">{t('veto.closed')}</span>;
  return (
    <time dateTime={closesAt} className={cn('tabular-nums', remaining < URGENT_MS ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
      {t('veto.closes', { clock: formatClock(closesAt), remaining: formatRemaining(remaining) })}
    </time>
  );
}

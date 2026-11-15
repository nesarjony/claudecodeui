import { useTranslation } from 'react-i18next';

import type { DegradedState } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';

/** Used by the status strip to say, for every dependency Foreman has lost, what it does meanwhile (BR-10.10). */
export function DegradedModes({ modes }: { modes: DegradedState[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <ul role="status" aria-label={t('degraded.label')} className="divide-y border-t bg-amber-500/5 text-sm">
      {modes.map(({ mode, since }) => (
        <li key={mode} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-1.5">
          <Chip tone="warn">{t(`degraded.${mode}.title`)}</Chip>
          <span className="min-w-0 flex-1 text-muted-foreground">{t(`degraded.${mode}.detail`)}</span>
          <span className="text-xs text-muted-foreground">{t('degraded.since', { clock: formatClock(since) })}</span>
        </li>
      ))}
    </ul>
  );
}

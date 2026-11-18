import { useTranslation } from 'react-i18next';

import type { DegradedState } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { degradedCatalogKey } from '@/modules/foreman-next/utils/degradedCatalog';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';

/** What a mode this screen has no sentence for says instead: the text of the alert Foreman raised when it lost that dependency, or a plain pointer to the alerts. */
function UnlistedDetail({ mode }: { mode: string }) {
  const { t } = useTranslation('foremanNext');
  const alerts = useForemanResource((api) => api.alerts());
  const alert = alerts.data?.find((item) => item.id === `lost:${mode}`);
  return <>{alert ? alert.text : t('degraded.unlisted.detail')}</>;
}

/** What Foreman says about this loss that the owner can act on (infigraph: which repo's code graph, and why it is not there); shown as text, and only when there is some. */
const reasonOf = (reason: unknown): string | null => (typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null);

/**
 * Used by the status strip to say, for every dependency Foreman has lost, what it does meanwhile (BR-10.10), and why when Foreman says so. Foreman may name a mode this build
 * does not know: it is shown as "Degraded: <mode>" with its alert, never as a missing translation or not at all.
 */
export function DegradedModes({ modes }: { modes: DegradedState[] }) {
  const { t, i18n } = useTranslation('foremanNext');
  return (
    <ul role="status" aria-label={t('degraded.label')} className="divide-y border-t bg-amber-500/5 text-sm">
      {modes.map(({ mode, since, reason }) => {
        const key = degradedCatalogKey(mode);
        const why = reasonOf(reason);
        const known = i18n.exists(`degraded.${key}.title`, { ns: 'foremanNext' });
        return (
          <li key={mode} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-1.5">
            <Chip tone="warn">{known ? t(`degraded.${key}.title`) : t('degraded.unlisted.title', { mode })}</Chip>
            <span className="min-w-0 flex-1 text-muted-foreground">{known ? t(`degraded.${key}.detail`) : <UnlistedDetail mode={mode} />}</span>
            <span className="text-xs text-muted-foreground">{t('degraded.since', { clock: formatClock(since) })}</span>
            {why ? <span className="basis-full break-words text-xs text-muted-foreground">{t('degraded.why')} {why}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

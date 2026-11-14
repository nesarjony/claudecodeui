import { HardHat } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by SidebarEntry for the sidebar's Foreman link, with the count of decisions that block work. */
export function ForemanSidebarLink() {
  const { t } = useTranslation('foremanNext');
  const status = useForemanResource((api) => api.status());
  const blocking = status.data?.blockingDecisions ?? 0;
  return (
    <Link to={foremanPath.today} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground">
      <HardHat className="h-3.5 w-3.5" />
      <span className="flex-1 text-sm">{t('nav.foreman')}</span>
      {blocking > 0 ? (
        <span aria-label={t('nav.blocking', { count: blocking })} className="rounded-full bg-amber-500/20 px-1.5 text-xs font-semibold tabular-nums text-amber-800 dark:text-amber-300">
          {blocking}
        </span>
      ) : null}
    </Link>
  );
}

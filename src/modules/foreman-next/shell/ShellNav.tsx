import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useForemanStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { cn } from '@/shared/utils';

const ITEMS = [
  { id: 'today', to: foremanPath.today, end: true },
  { id: 'decide', to: foremanPath.decide, end: false },
  { id: 'work', to: foremanPath.work, end: false },
  { id: 'settings', to: foremanPath.settings, end: false },
] as const;

/** Used by ForemanShell for the four destinations, with the count of decisions that block work next to Decide. */
export function ShellNav() {
  const { t } = useTranslation('foremanNext');
  const { data: status } = useForemanStatus();
  const blocking = status?.blockingDecisions ?? 0;
  return (
    <nav aria-label={t('nav.label')} className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
      {ITEMS.map((item) => (
        <NavLink
          key={item.id}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn('flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:bg-accent', isActive && 'bg-accent text-accent-foreground')
          }
        >
          {t(`nav.${item.id}`)}
          {item.id === 'decide' && blocking > 0 ? (
            <span aria-label={t('nav.blocking', { count: blocking })} className="rounded-full bg-amber-500/20 px-1.5 text-xs font-semibold tabular-nums text-amber-800 dark:text-amber-300">
              {blocking}
            </span>
          ) : null}
        </NavLink>
      ))}
      <Link to="/" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent md:mt-auto">
        ◂ {t('nav.workspace')}
      </Link>
      {status?.studioUrl ? (
        <a href={status.studioUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent">
          {t('nav.studio')} ↗
        </a>
      ) : null}
    </nav>
  );
}

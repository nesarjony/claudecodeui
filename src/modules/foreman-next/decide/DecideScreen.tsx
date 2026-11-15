import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useForemanStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { cn } from '@/shared/utils';

const TABS = [
  { id: 'needs', to: foremanPath.needsYou() },
  { id: 'review', to: foremanPath.review },
  { id: 'history', to: foremanPath.history },
] as const;

/** Used by ForemanNextRoutes for Decide (wireframes §5): Needs you, Review and History as tabs over the selected tab's content. */
export function DecideScreen() {
  const { t } = useTranslation('foremanNext');
  const { data: status } = useForemanStatus();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="sr-only">{t('nav.decide')}</h1>
      <nav aria-label={t('decide.tabs')} className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <NavLink
            key={tab.id}
            to={tab.to}
            className={({ isActive }) => cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t(`decide.tab.${tab.id}`)}
            {tab.id === 'needs' && status && status.blockingDecisions > 0 ? ` (${status.blockingDecisions})` : ''}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

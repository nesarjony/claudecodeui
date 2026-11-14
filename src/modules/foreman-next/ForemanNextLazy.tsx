import { lazy, Suspense } from 'react';

import { FOREMAN_NEXT_ENABLED } from '@/modules/foreman-next/flag';

// Each lazy import sits behind the flag, so a build with the flag off emits none of the new UI or its mock data.
const Routes = FOREMAN_NEXT_ENABLED ? lazy(() => import('@/modules/foreman-next/entry/RoutesEntry')) : null;
const SessionBar = FOREMAN_NEXT_ENABLED ? lazy(() => import('@/modules/foreman-next/entry/SessionBarEntry')) : null;
const SidebarEntry = FOREMAN_NEXT_ENABLED ? lazy(() => import('@/modules/foreman-next/entry/SidebarEntry')) : null;

/** Used by the app's router under `/foreman/*`: the new Foreman control UI, loaded on first visit. */
export function ForemanNextRoute() {
  return Routes ? (
    <Suspense fallback={null}>
      <Routes />
    </Suspense>
  ) : null;
}

/** Used by the project-workspace session view to hand one of the owner's own sessions to Foreman and take it back, and to show a worker session's banner. */
export function ForemanSessionBar({ sessionId }: { sessionId: string }) {
  return SessionBar ? (
    <Suspense fallback={null}>
      <SessionBar sessionId={sessionId} />
    </Suspense>
  ) : null;
}

/** Used by the sidebar footer for the link into the Foreman section, with the count of decisions that block work. */
export function ForemanSidebarEntry() {
  return SidebarEntry ? (
    <Suspense fallback={null}>
      <SidebarEntry />
    </Suspense>
  ) : null;
}

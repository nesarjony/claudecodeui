import '@/modules/foreman-next/i18n';
import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { foremanApi } from '@/modules/foreman-next/entry/foremanApi';
import { ForemanSidebarLink } from '@/modules/foreman-next/sidebar/ForemanSidebarLink';

/** Loaded lazily by ForemanSidebarEntry: the sidebar's Foreman link with the app's API. */
export default function SidebarEntry() {
  return (
    <ForemanApiProvider api={foremanApi}>
      <ForemanSidebarLink />
    </ForemanApiProvider>
  );
}

import { foremanApi } from '@/modules/foreman-next/entry/foremanApi';
import { ForemanNextRoutes } from '@/modules/foreman-next/ForemanNextRoutes';

/** Loaded lazily by ForemanNextRoute: the Foreman screens with the app's API. */
export default function RoutesEntry() {
  return <ForemanNextRoutes api={foremanApi} />;
}

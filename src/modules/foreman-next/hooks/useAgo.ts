import type { IsoTime } from '@/modules/foreman-next/api/contract';
import { useNow } from '@/modules/foreman-next/hooks/useNow';
import { formatAgo } from '@/modules/foreman-next/utils/foremanFormat';

const MINUTE_MS = 60_000;

/** Used by the decision cards and the Today panels to show how long ago something happened, kept current by the clock. */
export function useAgo(time: IsoTime): string {
  const now = useNow(MINUTE_MS);
  return formatAgo(now - new Date(time).getTime());
}

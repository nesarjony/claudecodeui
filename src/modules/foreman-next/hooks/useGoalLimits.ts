import { useTranslation } from 'react-i18next';

import type { GoalLimitsChange } from '@/modules/foreman-next/api/contract';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import type { Outcome } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { ApiRequestError } from '@/shared/api';

/** The statuses of a Foreman that has no such route (not found, not implemented): it is still being updated, which is not the goal's fault and not the owner's. */
const NO_SUCH_ROUTE = new Set([404, 501]);

/**
 * Used by the goal page's limit forms to change what a goal is limited to: only the fields in `change` move (a field left out is as it was, null takes the limit away).
 * A Foreman without the route says so in words rather than failing as a bare error, and what Foreman refuses for (a deadline that has passed, a goal that is done) is shown as it said it.
 */
export function useGoalLimits(goalId: string): { busy: boolean; failed: boolean; message: string | null; change: (change: GoalLimitsChange) => Promise<Outcome<unknown>> } {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, message, run } = useAction();
  const change = (limits: GoalLimitsChange) =>
    run(async () => {
      try {
        return await api.setGoalLimits(goalId, limits);
      } catch (error) {
        if (error instanceof ApiRequestError && NO_SUCH_ROUTE.has(error.status)) throw new Error(t('work.limits.unavailable'));
        throw error;
      }
    });
  return { busy, failed, message, change };
}

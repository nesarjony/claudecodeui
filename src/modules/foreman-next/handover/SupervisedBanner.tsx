import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

type SupervisedBannerProps = { sessionId: string; runId: string; goal: string | null };

/** Used by the session bar when Foreman is supervising one of the owner's sessions: the goal, a way to watch, and Take back. */
export function SupervisedBanner({ sessionId, runId, goal }: SupervisedBannerProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();

  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
      <span>
        {t('handover.banner')}
        {goal ? ` ${t('handover.goal', { goal })}` : ''}
      </span>
      <span className="flex items-center gap-2">
        {failed ? <InlineError /> : null}
        <Link to={foremanPath.run(runId)} className="text-primary hover:underline">
          {t('handover.watch')} ▸
        </Link>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.takeBackSession(sessionId))}>
          {t('handover.takeBack')}
        </Button>
      </span>
    </div>
  );
}

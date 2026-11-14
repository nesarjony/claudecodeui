import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

type WorkerBannerProps = { runId: string; goal: string; batch: string; model: string; sandboxed: boolean; control: 'foreman' | 'owner' };

/** Used by the session bar when the session is a Foreman worker (wireframes §3): who runs it, with Watch in Foreman and Take over, or "You're driving" with Hand back once the owner has taken over. */
export function WorkerBanner({ runId, goal, batch, model, sandboxed, control }: WorkerBannerProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();

  if (control === 'owner') {
    return (
      <div role="status" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
        <span>{t('run.drivingBanner', { batch })}</span>
        <span className="flex items-center gap-2">
          {failed ? <InlineError /> : null}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.handBackRun(runId))}>
            {t('run.handBack')}
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div role="status" className="space-y-0.5 border-b border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium">{[t('handover.worker.title'), goal, t('handover.worker.batch', { batch }), model, sandboxed ? t('run.sandboxed') : null, t('handover.worker.supervised')].filter(Boolean).join(' · ')}</span>
        <span className="flex items-center gap-2">
          {failed ? <InlineError /> : null}
          <Link to={foremanPath.run(runId)} className="text-primary hover:underline">
            {t('handover.watch')} ▸
          </Link>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.takeOverRun(runId))}>
            {t('run.takeOver')}
          </Button>
        </span>
      </div>
      <p className="text-muted-foreground">{t('handover.worker.labelled')}</p>
    </div>
  );
}

import { useTranslation } from 'react-i18next';

import type { RunDetail } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

/** Used by the run view for the three things that change what the owner should do: a failed run, a run the owner is driving, and a session handed over to Foreman. */
export function RunBanners({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run: perform } = useAction();
  const handBack = async () => {
    if (await perform(() => api.handBackRun(run.id))) onChanged();
  };
  return (
    <div className="space-y-2">
      {run.failure ? (
        <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
          {t('run.failure', { stage: t(`run.stage.${run.failure.stage}`), reason: run.failure.reason, next: t(`run.failureNext.${run.failure.next}`) })}
        </p>
      ) : null}
      {run.kind === 'worker' && run.control === 'owner' ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <span>{t('run.drivingBanner', { batch: run.batch })}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handBack()}>
            {t('run.handBack')}
          </Button>
        </div>
      ) : null}
      {run.kind === 'handed-over' ? (
        <p role="status" className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          {run.state === 'stopped' ? t('run.takenBack', { session: run.batch }) : t('run.handedOverBanner', { session: run.batch })}
          {run.goal ? ` ${t('run.handedOverGoal', { goal: run.goal })}` : ''}
        </p>
      ) : null}
      {failed ? <InlineError /> : null}
    </div>
  );
}

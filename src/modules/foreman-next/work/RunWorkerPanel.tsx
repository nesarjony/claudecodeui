import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { RunDetail } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';

/** Used by the run view for what the worker (or the handed-over session) is doing now, and the way into its session. */
export function RunWorkerPanel({ run }: { run: RunDetail }) {
  const { t } = useTranslation('foremanNext');
  const { worker } = run;
  return (
    <Panel title={t(run.kind === 'handed-over' ? 'run.session' : 'run.worker')}>
      {worker ? (
        <dl className="space-y-1 text-sm">
          <div className="flex gap-4">
            <dt className="w-20 text-muted-foreground">{t('run.now')}</dt>
            <dd>{worker.now}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-20 text-muted-foreground">{t('run.changed')}</dt>
            <dd>{t('run.changedLine', { files: worker.changed.files, added: worker.changed.added, removed: worker.changed.removed })}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-20 text-muted-foreground">{t('run.tools')}</dt>
            <dd>{worker.tools.join(', ')}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-20 text-muted-foreground">{t('run.says')}</dt>
            <dd>
              {worker.says} <span className="text-muted-foreground">({t('run.informational')})</span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t('run.workerDone')}</p>
      )}
      {run.sessionId ? (
        <Link to={`/session/${run.sessionId}`} className="mt-3 inline-block text-sm text-primary hover:underline">
          {t('run.openSession')} ↗
        </Link>
      ) : null}
    </Panel>
  );
}

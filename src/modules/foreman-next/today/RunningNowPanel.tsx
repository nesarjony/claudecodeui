import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { RunSummary } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { buttonVariants } from '@/shared/ui';

/** Used by the Today screen to list the batches running now, with a warning when one goes too long without a commit. */
export function RunningNowPanel({ running }: { running: RunSummary[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('today.running')}>
      {running.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('today.runningNone')}</p>
      ) : (
        <ul className="space-y-3">
          {running.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm">
                  <span className="font-medium">{run.batch}</span>{' '}
                  {run.kind === 'handed-over' ? <Chip tone="info">{t('work.handedOver')}</Chip> : null}{' '}
                  <span className="text-muted-foreground">{t(`today.stage.${run.stage}`, { turn: run.turn, rows: run.rows, minutes: run.elapsedMinutes })}</span>
                </div>
                {run.turnsWithoutCommit ? <p className="text-xs text-amber-700 dark:text-amber-400">! {t('today.stuck', { count: run.turnsWithoutCommit })}</p> : null}
              </div>
              <Link to={foremanPath.run(run.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('today.watch')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

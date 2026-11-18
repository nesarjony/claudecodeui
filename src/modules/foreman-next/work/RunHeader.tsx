import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { RunDetail } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { RunBanners } from '@/modules/foreman-next/work/RunBanners';
import { RunControls } from '@/modules/foreman-next/work/RunControls';
import { RunStages } from '@/modules/foreman-next/work/RunStages';

/** Used by the run view for where the run is: breadcrumb, model and clock, the stages, when Opus is next consulted, and the controls. */
export function RunHeader({ run }: { run: RunDetail }) {
  const { t } = useTranslation('foremanNext');
  const meta = [
    run.model,
    run.sandboxed ? t('run.sandboxed') : null,
    t('run.turn', { turn: run.turn }),
    t('run.elapsed', { minutes: run.elapsedMinutes }),
  ].filter(Boolean);
  return (
    <Panel title={t('run.title')} aside={<span>{meta.join(' · ')}</span>}>
      <div className="space-y-3 text-sm">
        <p>
          <Link to={run.goalId ? foremanPath.goal(run.goalId) : foremanPath.work} className="text-primary hover:underline">
            ◂ {run.goal && run.goalId ? run.goal : t('nav.work')}
          </Link>{' '}
          / <span className="font-medium">{run.batch}</span>
        </p>
        <RunStages stages={run.stages} />
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{t('run.nextCheck')}</span> {run.nextCheck}
        </p>
        <RunBanners run={run} />
        <RunControls run={run} />
      </div>
    </Panel>
  );
}

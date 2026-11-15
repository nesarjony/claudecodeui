import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { GoalDetail } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { formatDay } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

const SHORT_SHA = 7;

/** Used by the goal page for a goal on a read-only repo: that it waits for the repo's switch (nobody runs a worker on it), and how far the repo itself says the rows are, a point for each commit it was read at. */
export function ReadOnlyPanel({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('work.readOnly.title')}>
      <div className="space-y-2 text-sm">
        {goal.readOnly ? (
          <p>
            {t('work.readOnly.waits', { repo: goal.readOnly.repo })}{' '}
            <Link to={foremanPath.settings} className="text-primary hover:underline">
              {t('work.readOnly.settings')}
            </Link>
          </p>
        ) : null}
        {goal.repoProgress.length === 0 ? (
          <p className="text-muted-foreground">{t('work.readOnly.notRead')}</p>
        ) : (
          <ol aria-label={t('work.readOnly.history')} className="space-y-1">
            {goal.repoProgress.map((point) => (
              <li key={point.repoHead} className="tabular-nums text-muted-foreground">
                {t('work.readOnly.point', { day: formatDay(point.recordedAt), done: point.rowsDone, planned: point.rowsPlanned, head: point.repoHead.slice(0, SHORT_SHA) })}
                {point.complete ? ` · ${t('work.readOnly.complete')}` : ''}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

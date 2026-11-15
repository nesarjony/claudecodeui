import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { BatchEntry } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { StateGlyph } from '@/modules/foreman-next/components/StateGlyph';
import { formatUsd } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button, buttonVariants } from '@/shared/ui';

const LATEST_DONE = 1;
const NEXT_QUEUED = 1;

function visibleBatches(batches: BatchEntry[]): BatchEntry[] {
  const done = batches.filter((batch) => batch.state === 'done').slice(-LATEST_DONE);
  const queued = batches.filter((batch) => batch.state === 'queued').slice(0, NEXT_QUEUED);
  const current = batches.filter((batch) => batch.state === 'running' || batch.state === 'waiting');
  return [...current, ...queued, ...done].sort((first, second) => first.index - second.index);
}

function BatchStatus({ batch }: { batch: BatchEntry }) {
  const { t } = useTranslation('foremanNext');
  if (batch.state === 'running') return <>{t('work.batch.running', { turn: batch.turn ?? 0 })}</>;
  if (batch.state === 'waiting') return <>{t('work.batch.waits', { title: batch.waitsOn?.title ?? '' })}</>;
  if (batch.state === 'queued') return <>{t('work.batch.queued')}</>;
  return <>{batch.firstPass ? t('work.batch.firstPass', { passed: batch.firstPass.passed, of: batch.firstPass.of }) : t('work.batch.done')}</>;
}

function BatchAction({ batch }: { batch: BatchEntry }) {
  const { t } = useTranslation('foremanNext');
  if (batch.state === 'waiting' && batch.waitsOn) {
    return (
      <Link to={foremanPath.needsYou(batch.waitsOn.questionId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t('today.decide')}
      </Link>
    );
  }
  if (batch.runId && (batch.state === 'running' || batch.state === 'done')) {
    return (
      <Link to={foremanPath.run(batch.runId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t(batch.state === 'running' ? 'today.watch' : 'work.batch.open')}
      </Link>
    );
  }
  return null;
}

/** Used by the goal page for the batches: a strip of all of them, the ones that matter now, and a way to see every batch. */
export function BatchList({ batches }: { batches: BatchEntry[] }) {
  const { t } = useTranslation('foremanNext');
  // Whether every batch is listed; the default is the current ones and their neighbours, as in the wireframes.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? batches : visibleBatches(batches);
  return (
    <Panel title={t('work.batches')}>
      <div className="mb-3 flex flex-wrap gap-1.5" aria-label={t('work.batchStrip')} role="group">
        {batches.map((batch) => (
          <StateGlyph key={batch.index} state={batch.state} label={t('work.batchGlyph', { index: batch.index, name: batch.name, state: t(`work.batch.state.${batch.state}`) })} />
        ))}
      </div>
      <ul className="divide-y text-sm">
        {shown.map((batch) => (
          <li key={batch.index} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
            <span className="w-6 tabular-nums text-muted-foreground">{batch.index}</span>
            <span className="w-40 truncate font-medium">{batch.name}</span>
            <span className="w-20 text-muted-foreground">{t('work.batch.rows', { count: batch.rows })}</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <StateGlyph state={batch.state} label={t(`work.batch.state.${batch.state}`)} />
              <BatchStatus batch={batch} />
            </span>
            <span className="w-14 text-right tabular-nums text-muted-foreground">{batch.costUsd === null ? '' : formatUsd(batch.costUsd)}</span>
            <span className="w-20 text-right">
              <BatchAction batch={batch} />
            </span>
          </li>
        ))}
      </ul>
      {batches.length > shown.length || showAll ? (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll((open) => !open)}>
            {showAll ? t('work.batch.fewer') : t('work.batch.all', { count: batches.length })}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

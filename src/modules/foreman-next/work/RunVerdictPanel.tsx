import { useTranslation } from 'react-i18next';

import type { RunVerdict } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { StateGlyph } from '@/modules/foreman-next/components/StateGlyph';

function ExternalLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {label} ↗
    </a>
  );
}

/** Used by the run view for the checks Foreman ran in a clean copy and the judge's verdict row by row, or a note that they come after the worker finishes. */
export function RunVerdictPanel({ verdict }: { verdict: RunVerdict | null }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('run.verdict')}>
      {verdict ? (
        <dl className="space-y-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="font-medium">{t('run.checks')}</dt>
            <dd className="flex-1">
              {t('run.checkLine', { command: verdict.check.command, exit: verdict.check.exitCode })}
              {verdict.check.cleanCopy ? `, ${t('run.cleanCopy')}` : ''}
            </dd>
            <ExternalLink href={verdict.check.outputUrl} label={t('run.output')} />
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="font-medium">{t('run.judge')}</dt>
            <dd className="flex flex-1 flex-wrap gap-x-3">
              {verdict.rows.map((row) => (
                <span key={row.row} className="flex items-center gap-1">
                  {t('run.row', { row: row.row })} <StateGlyph state={row.passed ? 'done' : 'failed'} label={t(row.passed ? 'run.passed' : 'run.failed')} />
                  {row.note ? <span className="text-muted-foreground">{row.note}</span> : null}
                </span>
              ))}
            </dd>
            <ExternalLink href={verdict.verdictUrl} label={t('run.verdictLink')} />
          </div>
          {verdict.next ? (
            <div className="flex gap-4">
              <dt className="font-medium">{t('run.next')}</dt>
              <dd>{verdict.next}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t('run.verdictPending')}</p>
      )}
    </Panel>
  );
}

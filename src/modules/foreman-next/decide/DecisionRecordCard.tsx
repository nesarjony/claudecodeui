import { useTranslation } from 'react-i18next';

import type { DecisionRecord } from '@/modules/foreman-next/api/contract';
import { DecisionFeedbackForm } from '@/modules/foreman-next/decide/DecisionFeedbackForm';
import { formatSeconds, formatUsd } from '@/modules/foreman-next/utils/foremanFormat';
import { Card } from '@/shared/ui';

function Field({ label, children }: { label: string; children: string }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function MakerText({ record }: { record: DecisionRecord }) {
  const { t } = useTranslation('foremanNext');
  const { maker, model } = record;
  if (maker.type === 'code') return <>{t('record.makerCode')}</>;
  if (maker.type === 'owner') return <>{t('record.makerOwner')}</>;
  return <>{t('record.makerRole', { role: maker.role, version: maker.version, model: model ?? '' })}</>;
}

type DecisionRecordCardProps = { record: DecisionRecord; onSaved: () => void };

/** Used by the decision screen for one decision (wireframes §7): what Foreman saw, used, considered and chose, the outcome, its cost, and the owner's view. */
export function DecisionRecordCard({ record, onSaved }: DecisionRecordCardProps) {
  const { t } = useTranslation('foremanNext');
  return (
    <Card role="article" aria-label={record.title} className="space-y-4 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">{record.title}</h2>
        <p className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <MakerText record={record} /> · {formatUsd(record.costUsd)} · {formatSeconds(record.durationMs)}
          </span>
          {record.traceUrl ? (
            <a href={record.traceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              ↗ {t('record.trace')}
            </a>
          ) : null}
        </p>
      </header>
      <dl className="space-y-2">
        <Field label={t('record.saw')}>{record.saw}</Field>
        <Field label={t('record.used')}>{record.used.join(' · ')}</Field>
        <Field label={t('record.considered')}>{record.considered.join(' · ')}</Field>
        <Field label={t('record.chose')}>{record.chose}</Field>
        <Field label={t('record.outcome')}>{record.outcome ?? t('record.noOutcome')}</Field>
      </dl>
      <DecisionFeedbackForm record={record} onSaved={onSaved} />
    </Card>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { riskTone, statusTone } from '@/modules/foreman/chipTone';
import { Chip } from '@/modules/foreman/components/Chip';
import { Ago, Empty, LoadError, Loading, SessionLink } from '@/modules/foreman/components/Bits';
import TraceLink from '@/modules/foreman/components/TraceLink';
import { foremanTabApi } from '@/modules/foreman/api';
import { formatPercent, shortId } from '@/modules/foreman/format';
import { usePolledResource, type PolledResource } from '@/modules/foreman/usePolledResource';
import type { AgreementRange, DecisionItem } from '@/modules/foreman/types';

type DecisionsSectionProps = {
  decisions: PolledResource<DecisionItem[]>;
  limit: number;
  onLoadMore: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Whether the section is open and the tab in front: agreement polls only then. */
  live: boolean;
};

const AGREEMENT_RANGES: AgreementRange[] = ['7d', '30d', 'all'];

function Agreement({ live }: { live: boolean }) {
  const { t } = useTranslation('foreman');
  const [range, setRange] = useState<AgreementRange>('7d');
  const report = usePolledResource(() => foremanTabApi.agreement(range), { enabled: live, key: range });
  const overall = report.data?.overall;
  return (
    <div data-testid="foreman-agreement-report" className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">{t('decisions.agreement')}</span>
        <div role="radiogroup" aria-label={t('decisions.agreementRange')} className="flex rounded-md border border-border/60 bg-muted/40 p-0.5">
          {AGREEMENT_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={range === value}
              onClick={() => setRange(value)}
              className={`min-h-8 rounded px-2 text-[11px] font-medium ${range === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              {t(`ranges.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {report.error && <LoadError error={report.error} onRetry={() => void report.refresh()} />}
      {!overall && !report.error && <p className="text-xs text-muted-foreground">{t('common.loading')}</p>}
      {overall && overall.answered === 0 && <p className="text-xs text-muted-foreground">{t('decisions.agreementNone')}</p>}
      {overall && overall.answered > 0 && report.data && (
        <>
          <p className="text-xs text-foreground">
            {t('decisions.agreementSummary', { accepted: formatPercent(overall.acceptanceRate), used: formatPercent(overall.usedRate), count: overall.answered })}
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {report.data.byAction.slice(0, 6).map((bucket) => (
              <li key={bucket.key}>
                <Chip title={t('decisions.agreementBucket', { sent: bucket.sent, edited: bucket.edited, dismissed: bucket.dismissed })}>
                  {t(`chat:foreman.actions.${bucket.key}`, { defaultValue: bucket.key })} {formatPercent(bucket.acceptanceRate)}
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Row({ item, onOpenSession }: { item: DecisionItem; onOpenSession: (id: string) => void }) {
  const { t } = useTranslation('foreman');
  const [open, setOpen] = useState(false);
  const action = t(`chat:foreman.actions.${item.action}`, { defaultValue: item.action });
  return (
    <li data-testid="foreman-decision" data-action={item.action} data-status={item.status} className="min-w-0 rounded-lg border border-border/50 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="block min-h-11 w-full min-w-0 space-y-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
      >
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {action}
            {item.kind === 'action' && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{t('decisions.auto')}</span>}
          </span>
          <Ago iso={item.ts} className="shrink-0 text-[11px] text-muted-foreground" />
        </span>
        <span className={`block break-words text-xs text-muted-foreground ${open ? '' : 'line-clamp-2'}`}>{item.reason}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip title={t('decisions.confidenceTitle')}>{t('decisions.confidence', { percent: Math.round(item.confidence * 100) })}</Chip>
          <Chip tone={riskTone(item.risk)}>{t(`decisions.risk.${item.risk}`, { defaultValue: item.risk })}</Chip>
          <Chip tone={statusTone(item.status)}>{t(`decisions.status.${item.status}`, { defaultValue: item.status })}</Chip>
          <Chip>{item.escalated ? t('decisions.secondOpinion', { model: item.model }) : item.model}</Chip>
        </span>
      </button>
      {open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-2.5 pb-2.5 pt-2">
          {item.detail && <p className="basis-full whitespace-pre-wrap break-words text-xs text-foreground/90">{item.detail}</p>}
          <p className="basis-full break-all text-[11px] text-muted-foreground">
            {t('decisions.ids', { id: shortId(item.id), session: shortId(item.sessionId), task: item.taskId ? shortId(item.taskId) : '-' })}
          </p>
          <SessionLink sessionId={item.sessionId} onOpen={onOpenSession} />
          {item.traceId ? <TraceLink traceId={item.traceId} /> : <span className="text-[11px] text-muted-foreground">{t('trace.none')}</span>}
        </div>
      )}
    </li>
  );
}

/** The live feed: what Foreman decided, newest first. Tap a row for the details, its session and its Studio trace. */
export default function DecisionsSection({ decisions, limit, onLoadMore, onOpenSession, live }: DecisionsSectionProps) {
  const { t } = useTranslation('foreman');
  return (
    <>
      <Agreement live={live} />
      {decisions.error && <LoadError error={decisions.error} onRetry={() => void decisions.refresh()} />}
      {!decisions.data && !decisions.error && <Loading />}
      {decisions.data && decisions.data.length === 0 && <Empty>{t('decisions.empty')}</Empty>}
      {decisions.data && decisions.data.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-1.5 p-0">
          {decisions.data.map((item) => (
            <Row key={`${item.kind ?? 'suggestion'}-${item.id}`} item={item} onOpenSession={onOpenSession} />
          ))}
        </ul>
      )}
      {decisions.data && decisions.data.length >= limit && (
        <button type="button" onClick={onLoadMore} className="min-h-10 w-full rounded-lg border border-border/60 text-xs font-medium text-foreground hover:bg-muted/60">
          {t('decisions.more')}
        </button>
      )}
    </>
  );
}

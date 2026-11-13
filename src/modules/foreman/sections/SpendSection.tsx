import { useTranslation } from 'react-i18next';

import { Empty, LoadError, Loading } from '@/modules/foreman/components/Bits';
import { formatTokens, formatUsd, shortId } from '@/modules/foreman/format';
import type { PolledResource } from '@/modules/foreman/usePolledResource';
import type { SpendRange, SpendReport } from '@/modules/foreman/types';

const SPEND_RANGES: SpendRange[] = ['today', '7d', '30d'];
const TOP = 5;

type Row = { key: string; costUsd: number; detail: string };

function Breakdown({ title, rows, label }: { title: string; rows: Row[]; label?: (key: string) => string }) {
  const { t } = useTranslation('foreman');
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((row) => row.costUsd), 0.000001);
  return (
    <div className="min-w-0 space-y-1.5">
      <h3 className="m-0 text-xs font-semibold text-foreground/80">{title}</h3>
      <ul className="m-0 min-w-0 list-none space-y-1.5 p-0">
        {rows.slice(0, TOP).map((row) => (
          <li key={row.key} className="min-w-0" data-testid="foreman-spend-row">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-xs text-foreground" title={row.key}>{label ? label(row.key) : row.key}</span>
              <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">{formatUsd(row.costUsd)}</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, (row.costUsd / max) * 100)}%` }} />
            </div>
            <div className="text-[11px] text-muted-foreground">{row.detail}</div>
          </li>
        ))}
      </ul>
      {rows.length > TOP && <p className="m-0 text-[11px] text-muted-foreground">{t('spend.more', { count: rows.length - TOP })}</p>}
    </div>
  );
}

type SpendSectionProps = {
  spend: PolledResource<SpendReport>;
  range: SpendRange;
  onRange: (range: SpendRange) => void;
};

/** Foreman's own LLM spend and the workers' spend, for today, 7 days or 30 days, broken down. */
export default function SpendSection({ spend, range, onRange }: SpendSectionProps) {
  const { t } = useTranslation('foreman');
  const data = spend.data;
  const idLabel = (key: string) => (key.length > 24 ? shortId(key, 12) : key);
  return (
    <>
      <div role="radiogroup" aria-label={t('spend.rangeLabel')} className="grid grid-cols-3 rounded-lg border border-border/60 bg-muted/40 p-0.5">
        {SPEND_RANGES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={range === value}
            onClick={() => onRange(value)}
            className={`min-h-10 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${range === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(`ranges.${value}`)}
          </button>
        ))}
      </div>
      {spend.error && <LoadError error={spend.error} onRetry={() => void spend.refresh()} />}
      {!data && !spend.error && <Loading />}
      {data && (
        <div className="space-y-4" data-testid="foreman-spend" data-range={data.range}>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-1 py-2">
              <span className="block text-base font-semibold tabular-nums text-foreground" data-testid="foreman-spend-foreman-total">{formatUsd(data.foreman.total)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{t('spend.foreman', { count: data.foreman.calls })}</span>
            </div>
            <div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-1 py-2">
              <span className="block text-base font-semibold tabular-nums text-foreground" data-testid="foreman-spend-worker-total">{formatUsd(data.worker.total)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{t('spend.workers', { count: data.worker.turns })}</span>
            </div>
          </div>
          {data.foreman.total === 0 && data.worker.total === 0 && <Empty>{t('spend.empty')}</Empty>}
          <Breakdown
            title={t('spend.foremanByRole')}
            rows={data.foreman.byRole.map((row) => ({ key: row.key, costUsd: row.costUsd, detail: t('spend.callsDetail', { calls: row.calls, input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) }) }))}
          />
          <Breakdown
            title={t('spend.foremanByModel')}
            rows={data.foreman.byModel.map((row) => ({ key: row.key, costUsd: row.costUsd, detail: t('spend.callsDetail', { calls: row.calls, input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) }) }))}
          />
          <Breakdown
            title={t('spend.workerByModel')}
            rows={data.worker.byModel.map((row) => ({ key: row.key, costUsd: row.costUsd, detail: t('spend.turnsDetail', { turns: row.turns, tools: row.toolCalls }) }))}
          />
          <Breakdown
            title={t('spend.workerByTask')}
            label={idLabel}
            rows={data.worker.byTask.map((row) => ({ key: row.key, costUsd: row.costUsd, detail: t('spend.turnsDetail', { turns: row.turns, tools: row.toolCalls }) }))}
          />
          <Breakdown
            title={t('spend.workerBySession')}
            label={idLabel}
            rows={data.worker.bySession.map((row) => ({ key: row.key, costUsd: row.costUsd, detail: t('spend.turnsDetail', { turns: row.turns, tools: row.toolCalls }) }))}
          />
        </div>
      )}
    </>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HardHat, OctagonX, Play } from 'lucide-react';

import { Button } from '@/shared/ui';
import { foremanTabApi } from '@/modules/foreman/api';
import ConfirmDialog from '@/modules/foreman/components/ConfirmDialog';
import { LoadError } from '@/modules/foreman/components/Bits';
import { formatPercent, formatUsd } from '@/modules/foreman/format';
import type { PolledResource } from '@/modules/foreman/usePolledResource';
import type { ForemanMode, Overview } from '@/modules/foreman/types';

type StatusBarProps = {
  overview: PolledResource<Overview>;
  /** Scrolls to and opens the "Needs you" section. */
  onShowNeedsYou: () => void;
};

type Pending = { kind: 'kill' } | { kind: 'resume' } | { kind: 'mode'; mode: ForemanMode };

/** Mode, kill switch, today's spend against the limit, and the counts that matter at a glance. Always visible. */
export default function StatusBar({ overview, onShowNeedsYou }: StatusBarProps) {
  const { t } = useTranslation('foreman');
  const [pending, setPending] = useState<Pending | null>(null);
  const data = overview.data;

  const run = async () => {
    if (!pending) return;
    if (pending.kind === 'kill') await foremanTabApi.kill();
    else if (pending.kind === 'resume') await foremanTabApi.resume();
    else await foremanTabApi.putConfig({ mode: pending.mode });
    await overview.refresh();
    setPending(null);
  };

  const dialog = (() => {
    if (!pending) return null;
    if (pending.kind === 'kill') {
      return { title: t('status.killConfirmTitle'), description: t('status.killConfirmBody'), confirmLabel: t('status.killConfirm'), tone: 'danger' as const };
    }
    if (pending.kind === 'resume') {
      return { title: t('status.resumeConfirmTitle'), description: t('status.resumeConfirmBody'), confirmLabel: t('status.resumeConfirm'), tone: 'default' as const };
    }
    return {
      title: t('status.modeConfirmTitle', { mode: t(`status.mode.${pending.mode}`) }),
      description: pending.mode === 'autonomous' ? t('status.modeConfirmAutonomous') : t('status.modeConfirmShadow'),
      confirmLabel: t('status.modeConfirm', { mode: t(`status.mode.${pending.mode}`) }),
      tone: 'default' as const,
    };
  })();

  const budget = data?.budgets.today;
  const total = budget ? budget.foremanUsd + budget.workerUsd : 0;
  const limit = budget?.limitUsd ?? 0;
  const over = limit > 0 && total > limit;
  const scale = Math.max(limit, total, 0.000001);
  const foremanWidth = budget ? (budget.foremanUsd / scale) * 100 : 0;
  const workerWidth = budget ? (budget.workerUsd / scale) * 100 : 0;
  const agreement = data?.agreement7d;

  return (
    <div data-testid="foreman-status" className="min-w-0 space-y-3 rounded-xl border border-border/60 bg-card/70 p-3 text-[13px] leading-5">
      <div className="flex min-w-0 items-center gap-2">
        <HardHat className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h1 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{t('tabs.title')}</h1>
        {data && (
          <div role="radiogroup" aria-label={t('status.modeLabel')} className="flex shrink-0 rounded-lg border border-border/60 bg-muted/40 p-0.5">
            {(['shadow', 'autonomous'] as const).map((mode) => {
              const selected = data.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => { if (!selected) setPending({ kind: 'mode', mode }); }}
                  className={`min-h-9 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(`status.mode.${mode}`)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {overview.error && <LoadError error={overview.error} onRetry={() => void overview.refresh()} />}
      {!data && !overview.error && <p className="text-xs text-muted-foreground">{t('common.loading')}</p>}

      {data?.killed && (
        <p role="status" data-testid="foreman-killed" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-400">
          {t('status.killed')}
        </p>
      )}

      {data && budget && (
        <div className="space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-xs font-medium text-muted-foreground">{t('status.today')}</span>
            <span data-testid="foreman-spend-today" className={`text-sm font-semibold tabular-nums ${over ? 'text-red-700 dark:text-red-400' : 'text-foreground'}`}>
              {t('status.spendOfLimit', { spent: formatUsd(total), limit: formatUsd(limit) })}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={t('status.budgetLabel')}
            aria-valuemin={0}
            aria-valuemax={Math.round(limit * 100) / 100}
            aria-valuenow={Math.round(total * 100) / 100}
            className="flex h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className={over ? 'bg-red-500' : 'bg-primary'} style={{ width: `${foremanWidth}%` }} />
            <div className={over ? 'bg-red-400' : 'bg-primary/45'} style={{ width: `${workerWidth}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
            <span>{t('status.foremanSpend', { amount: formatUsd(budget.foremanUsd) })}</span>
            <span>{t('status.workerSpend', { amount: formatUsd(budget.workerUsd) })}</span>
          </div>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <button
            type="button"
            onClick={onShowNeedsYou}
            data-testid="foreman-needs-count"
            className={`min-h-14 min-w-0 rounded-lg border px-1 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              data.needsUserCount > 0 ? 'border-amber-500/50 bg-amber-500/10' : 'border-border/60 bg-muted/30 hover:bg-muted/60'
            }`}
          >
            <span className="block text-lg font-semibold tabular-nums leading-6 text-foreground">{data.needsUserCount}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{t('status.needsYou')}</span>
          </button>
          <div className="min-h-14 min-w-0 rounded-lg border border-border/60 bg-muted/30 px-1 py-1.5" data-testid="foreman-active-count">
            <span className="block text-lg font-semibold tabular-nums leading-6 text-foreground">{data.activeTasks}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{t('status.activeTasks')}</span>
          </div>
          <div className="min-h-14 min-w-0 rounded-lg border border-border/60 bg-muted/30 px-1 py-1.5" data-testid="foreman-agreement">
            <span className="block text-lg font-semibold tabular-nums leading-6 text-foreground">
              {agreement && agreement.answered > 0 ? formatPercent(agreement.acceptanceRate) : t('status.none')}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground" title={agreement ? t('status.agreementTitle', { count: agreement.answered }) : undefined}>
              {t('status.agreement')}
            </span>
          </div>
        </div>
      )}

      {data &&
        (data.killed ? (
          <Button className="h-12 w-full gap-2 text-base" onClick={() => setPending({ kind: 'resume' })}>
            <Play aria-hidden /> {t('status.resume')}
          </Button>
        ) : (
          <Button variant="destructive" className="h-12 w-full gap-2 text-base" onClick={() => setPending({ kind: 'kill' })}>
            <OctagonX aria-hidden /> {t('status.kill')}
          </Button>
        ))}

      {dialog && (
        <ConfirmDialog
          open
          title={dialog.title}
          description={dialog.description}
          confirmLabel={dialog.confirmLabel}
          tone={dialog.tone}
          onConfirm={run}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

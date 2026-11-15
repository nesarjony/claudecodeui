import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { Strategy } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';
import { Button, Input } from '@/shared/ui';

type StrategyPanelProps = { goalId: string; strategy: Strategy; compareOnOpen: boolean };

/** Used by the goal page for the strategy: its steps and risks, the comparison with the previous version, and Approve or Adjust while it waits for the owner (BR-1.11). */
export function StrategyPanel({ goalId, strategy, compareOnOpen }: StrategyPanelProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // Whether the previous version's steps are shown next to the current ones; a Review link to a re-plan's diff opens it already.
  const [comparing, setComparing] = useState(compareOnOpen);
  // Whether the Adjust note field is open, and what has been typed.
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState('');
  const awaiting = strategy.status === 'awaiting-approval';

  const sendAdjustment = async (event: FormEvent) => {
    event.preventDefault();
    const sent = await run(() => api.adjustStrategy(goalId, note.trim()));
    if (sent.ok) {
      setAdjusting(false);
      setNote('');
    }
  };

  return (
    <Panel
      title={t('work.strategy.title', { version: strategy.version })}
      aside={
        <>
          <span>{t('work.strategy.replanned', { clock: formatClock(strategy.replannedAt), reason: strategy.reason })}</span>
          {strategy.previous ? (
            <Button variant="ghost" size="sm" aria-expanded={comparing} onClick={() => setComparing((open) => !open)}>
              {t('work.strategy.compare', { version: strategy.previous.version })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {awaiting ? <Chip tone="warn">{t('work.strategy.awaiting')}</Chip> : null}
        <ol className="list-decimal space-y-1 pl-5">
          {strategy.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {strategy.risks.length > 0 ? <p className="text-muted-foreground">{t('work.strategy.risk', { risks: strategy.risks.join(' · ') })}</p> : null}
        {comparing && strategy.previous ? (
          <div className="rounded-md bg-muted/50 p-3">
            <p className="mb-1 text-xs font-medium">{t('work.strategy.version', { version: strategy.previous.version })}</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              {strategy.previous.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ) : null}
        {awaiting ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void run(() => api.approveStrategy(goalId))}>
                {t('work.strategy.approve')}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} aria-expanded={adjusting} onClick={() => setAdjusting(true)}>
                {t('work.strategy.adjust')}
              </Button>
            </div>
            {adjusting ? (
              <form onSubmit={(event) => void sendAdjustment(event)} className="flex flex-wrap items-center gap-2">
                <label htmlFor="strategy-note" className="text-sm text-muted-foreground">
                  {t('work.strategy.note')}
                </label>
                <Input id="strategy-note" value={note} onChange={(event) => setNote(event.target.value)} className="min-w-0 flex-1" />
                <Button type="submit" size="sm" disabled={busy || note.trim() === ''}>
                  {t('decide.send')}
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
        {failed ? <InlineError /> : null}
      </div>
    </Panel>
  );
}

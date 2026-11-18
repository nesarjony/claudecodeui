import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { GoalLimitsChange } from '@/modules/foreman-next/api/contract';
import type { Outcome } from '@/modules/foreman-next/hooks/useAction';
import { parseBudgetInput } from '@/modules/foreman-next/utils/goalLimits';
import { Button, Input } from '@/shared/ui';

type BudgetLimitFormProps = { limitUsd: number | null; held: boolean; busy: boolean; change: (change: GoalLimitsChange) => Promise<Outcome<unknown>> };

/** Used by the goal page's limits panel to set, raise or remove the goal's budget in dollars: it saves only a positive amount, and removing it sends null. */
export function BudgetLimitForm({ limitUsd, held, busy, change }: BudgetLimitFormProps) {
  const { t } = useTranslation('foremanNext');
  const inputId = useId();
  const errorId = useId();
  // What the owner typed; until he types, the field shows the budget Foreman has.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (limitUsd === null ? '' : String(limitUsd));
  const typed = parseBudgetInput(text);
  const invalid = draft !== null && typed.kind === 'invalid';
  const changed = draft !== null && typed.kind === 'ok' && typed.value !== limitUsd;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (typed.kind !== 'ok' || !changed) return;
    if ((await change({ budgetUsd: typed.value })).ok) setDraft(null);
  };
  const remove = async () => {
    if ((await change({ budgetUsd: null })).ok) setDraft(null);
  };

  return (
    <form onSubmit={(event) => void save(event)} aria-label={t('work.limits.budgetForm')} className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t('work.limits.budgetLabel')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={text}
          inputMode="decimal"
          placeholder="60"
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          className="w-32"
        />
        <Button type="submit" size="sm" variant={held ? 'default' : 'outline'} disabled={busy || !changed}>
          {held ? t('work.limits.raise') : limitUsd === null ? t('work.limits.set') : t('common.save')}
        </Button>
        {limitUsd === null ? null : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
            {t('work.limits.removeBudget')}
          </Button>
        )}
      </div>
      {invalid && typed.kind === 'invalid' ? (
        <p id={errorId} className="text-xs text-red-700 dark:text-red-400">
          {t(`work.limits.error.${typed.reason}`)}
        </p>
      ) : null}
    </form>
  );
}

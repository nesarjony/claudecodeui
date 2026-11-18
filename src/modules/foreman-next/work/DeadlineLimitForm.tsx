import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { GoalLimitsChange, IsoTime } from '@/modules/foreman-next/api/contract';
import type { Outcome } from '@/modules/foreman-next/hooks/useAction';
import { dateInputOf, parseDeadlineInput } from '@/modules/foreman-next/utils/goalLimits';
import { Button, Input } from '@/shared/ui';

type DeadlineLimitFormProps = { deadline: IsoTime | null; busy: boolean; change: (change: GoalLimitsChange) => Promise<Outcome<unknown>> };

/** Used by the goal page's limits panel to set, move or remove the goal's deadline: a day that has not passed, kept to the end of that day in the owner's time zone; removing it sends null. */
export function DeadlineLimitForm({ deadline, busy, change }: DeadlineLimitFormProps) {
  const { t } = useTranslation('foremanNext');
  const inputId = useId();
  const errorId = useId();
  // What the owner picked; until he picks, the field shows the deadline Foreman has.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (deadline === null ? '' : dateInputOf(deadline));
  const typed = parseDeadlineInput(text, new Date());
  const invalid = draft !== null && typed.kind === 'invalid';
  const changed = draft !== null && typed.kind === 'ok' && typed.value !== deadline;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (typed.kind !== 'ok' || !changed) return;
    if ((await change({ deadline: typed.value })).ok) setDraft(null);
  };
  const remove = async () => {
    if ((await change({ deadline: null })).ok) setDraft(null);
  };

  return (
    <form onSubmit={(event) => void save(event)} aria-label={t('work.limits.deadlineForm')} className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t('work.limits.deadlineLabel')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="date"
          value={text}
          min={dateInputOf(new Date())}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          className="w-44"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !changed}>
          {deadline === null ? t('work.limits.set') : t('common.save')}
        </Button>
        {deadline === null ? null : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
            {t('work.limits.removeDeadline')}
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

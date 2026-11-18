import { useTranslation } from 'react-i18next';

import type { GoalBudget, GoalDetail } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { useGoalLimits } from '@/modules/foreman-next/hooks/useGoalLimits';
import { formatDay, formatUsd, formatWeekday } from '@/modules/foreman-next/utils/foremanFormat';
import { budgetOf, heldForBudget } from '@/modules/foreman-next/utils/goalLimits';
import { BudgetLimitForm } from '@/modules/foreman-next/work/BudgetLimitForm';
import { DeadlineLimitForm } from '@/modules/foreman-next/work/DeadlineLimitForm';

function BudgetLine({ budget, spentUsd }: { budget: GoalBudget; spentUsd: number }) {
  const { t } = useTranslation('foremanNext');
  const { limitUsd, projectedUsd, fits } = budget;
  if (limitUsd === null) return <p className="text-sm text-muted-foreground">{t('work.limits.noBudget')}</p>;
  return (
    <div className="space-y-0.5 text-sm">
      <p>{t('work.limits.budgetLine', { limit: formatUsd(limitUsd), spent: formatUsd(spentUsd) })}</p>
      {projectedUsd === null || fits === null ? null : <p className="text-muted-foreground">{t(fits ? 'work.limits.projectedFits' : 'work.limits.projectedOver', { projected: formatUsd(projectedUsd) })}</p>}
    </div>
  );
}

function DeadlineLine({ budget }: { budget: GoalBudget }) {
  const { t } = useTranslation('foremanNext');
  const { deadline, onTime } = budget;
  if (deadline === null) return <p className="text-sm text-muted-foreground">{t('work.limits.noDeadline')}</p>;
  return (
    <div className="space-y-0.5 text-sm">
      <p>{t('work.limits.deadlineLine', { day: `${formatWeekday(deadline)} ${formatDay(deadline)}` })}</p>
      {onTime === null ? null : <p className="text-muted-foreground">{t(onTime ? 'work.limits.onTime' : 'work.limits.late')}</p>}
    </div>
  );
}

/**
 * Used by the goal page for what the owner limited the goal to (BR-1.1): its budget and deadline against the forecast, and the controls to set, raise or remove either. A goal that has
 * used up its budget says so, with the budget field ready to raise. The success measure is the header's "Done when". A Foreman that sends no limits yet gets no panel.
 */
export function GoalLimits({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foremanNext');
  const limits = useGoalLimits(goal.id);
  const budget = budgetOf(goal);
  if (budget === null) return null;
  const held = heldForBudget(goal);
  // A finished goal has nothing left to limit: Foreman refuses the change, so the controls are not offered.
  const editable = goal.state !== 'done';
  return (
    <Panel title={t('work.limits.title')}>
      <div className="space-y-4">
        {held && budget.limitUsd !== null ? (
          <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            {t('work.limits.held', { limit: formatUsd(budget.limitUsd), spent: formatUsd(goal.spentUsd) })}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <section aria-label={t('work.limits.budgetLabel')} className="space-y-2">
            <BudgetLine budget={budget} spentUsd={goal.spentUsd} />
            {editable ? <BudgetLimitForm limitUsd={budget.limitUsd} held={held} busy={limits.busy} change={limits.change} /> : null}
          </section>
          <section aria-label={t('work.limits.deadlineLabel')} className="space-y-2">
            <DeadlineLine budget={budget} />
            {editable ? <DeadlineLimitForm deadline={budget.deadline} busy={limits.busy} change={limits.change} /> : null}
          </section>
        </div>
        {limits.failed ? <InlineError message={limits.message} /> : null}
      </div>
    </Panel>
  );
}

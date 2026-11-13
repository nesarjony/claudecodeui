import { useTranslation } from 'react-i18next';

import type { ChipTone } from '@/modules/foreman/chipTone';
import { Chip } from '@/modules/foreman/components/Chip';
import { formatUsd } from '@/modules/foreman/format';
import { budgetUse, goalProgress, goalStatusTone, goalTaskStatusTone } from '@/modules/foreman/goals/goalView';
import type { GoalListItem } from '@/modules/foreman/goals/types';

export function GoalStatusChip({ status }: { status: string }) {
  const { t } = useTranslation('foreman');
  return <Chip tone={goalStatusTone(status)}>{t(`goals.status.${status}`, { defaultValue: status })}</Chip>;
}

export function GoalTaskStatusChip({ status }: { status: string }) {
  const { t } = useTranslation('foreman');
  return <Chip tone={goalTaskStatusTone(status)}>{t(`goals.taskStatus.${status}`, { defaultValue: status })}</Chip>;
}

const BAR: Record<ChipTone, string> = {
  neutral: 'bg-primary',
  info: 'bg-primary',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};

const FIGURE: Record<ChipTone, string> = {
  neutral: 'text-foreground',
  info: 'text-foreground',
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
};

/** A labelled thin bar. Spans only, so it can sit inside a card's button. */
function Meter({ label, figure, width, tone, testId }: { label: string; figure: string; width: number; tone: ChipTone; testId: string }) {
  return (
    <span className="block min-w-0 space-y-1" data-testid={testId} data-tone={tone}>
      <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium tabular-nums ${FIGURE[tone]}`}>{figure}</span>
      </span>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-valuetext={figure}
        className="block h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span className={`block h-full rounded-full ${BAR[tone]}`} style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/** "3 of 7 tasks" and its bar; "No plan yet" before the plan exists. */
export function TaskProgress({ goal }: { goal: Pick<GoalListItem, 'tasksDone' | 'tasksTotal'> }) {
  const { t } = useTranslation('foreman');
  const progress = goalProgress(goal);
  return (
    <Meter
      testId="foreman-goal-progress"
      label={t('goals.progressLabel')}
      figure={progress.total === 0 ? t('goals.noPlan') : t('goals.progress', { done: progress.done, total: progress.total })}
      width={progress.percent}
      tone={progress.total > 0 && progress.done === progress.total ? 'good' : 'neutral'}
    />
  );
}

/** "$0.420 of $5.00" and its bar: amber from 80% of the budget, red at 100%. */
export function BudgetMeter({ spentUsd, budgetUsd }: { spentUsd: number; budgetUsd: number }) {
  const { t } = useTranslation('foreman');
  const use = budgetUse(spentUsd, budgetUsd);
  return (
    <Meter
      testId="foreman-goal-budget-meter"
      label={t('goals.budgetLabel')}
      figure={t('goals.spendOfBudget', { spent: formatUsd(spentUsd), budget: formatUsd(budgetUsd) })}
      width={use.width}
      tone={use.tone}
    />
  );
}

import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';

import { Ago } from '@/modules/foreman/components/Bits';
import { Chip } from '@/modules/foreman/components/Chip';
import { repoLabel } from '@/modules/foreman/format';
import { BudgetMeter, GoalStatusChip, TaskProgress } from '@/modules/foreman/goals/GoalBits';
import { isOverdue, nextLine } from '@/modules/foreman/goals/goalView';
import type { GoalListItem } from '@/modules/foreman/goals/types';
import { useNow } from '@/modules/foreman/useNow';

/** One goal in the list: status, progress, spend against the budget and what comes next. Tap it for the detail. */
export default function GoalCard({ goal, onOpen }: { goal: GoalListItem; onOpen: (id: string) => void }) {
  const { t } = useTranslation('foreman');
  const now = useNow();
  const next = nextLine(goal.next, (kind) => t(`goals.next.${kind}`));
  const overdue = isOverdue(goal, now);

  return (
    <li data-testid="foreman-goal" data-status={goal.status} className="min-w-0 rounded-lg border border-border/50 bg-background/40">
      <button
        type="button"
        onClick={() => onOpen(goal.id)}
        className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
      >
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="block break-words text-sm font-medium text-foreground">{goal.title}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <GoalStatusChip status={goal.status} />
            {overdue && <Chip tone="bad">{t('goals.overdue')}</Chip>}
            {goal.repos.map((repo) => (
              <Chip key={repo}>{repoLabel(repo)}</Chip>
            ))}
            <Ago iso={goal.updatedAt} />
          </span>
          <TaskProgress goal={goal} />
          <BudgetMeter spentUsd={goal.spentUsd} budgetUsd={goal.budgetUsd} />
          {next && (
            <span data-testid="foreman-goal-next" className="block break-words text-xs text-muted-foreground">
              {t('goals.nextLine', { text: next })}
            </span>
          )}
        </span>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';

import { Ago, LoadError, Loading } from '@/modules/foreman/components/Bits';
import { Chip } from '@/modules/foreman/components/Chip';
import TraceLink from '@/modules/foreman/components/TraceLink';
import { formatUsd, repoLabel } from '@/modules/foreman/format';
import { goalsApi } from '@/modules/foreman/goals/api';
import { BudgetMeter, GoalStatusChip, TaskProgress } from '@/modules/foreman/goals/GoalBits';
import { GoalControls, PendingAnswer, PlanApproval } from '@/modules/foreman/goals/GoalDecisions';
import { GoalPlanView, GoalVerdicts } from '@/modules/foreman/goals/GoalPlan';
import { formatDateTime, goalActions, isActiveGoal, isOverdue, nextLine } from '@/modules/foreman/goals/goalView';
import type { GoalDetail, GoalListItem, GoalTaskView } from '@/modules/foreman/goals/types';
import { TaskDetailView } from '@/modules/foreman/sections/TasksSection';
import { usePolledResource } from '@/modules/foreman/usePolledResource';
import { useNow } from '@/shared/hooks/useNow';

const HEADING = 'm-0 text-xs font-semibold text-foreground/80';
const TIMELINE_SHOWN = 8;

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border/30 py-1 last:border-0">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 shrink-0 font-medium tabular-nums text-foreground" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function GoalBudget({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foreman');
  const { spend } = goal;
  return (
    <div data-testid="foreman-goal-budget" className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className={HEADING}>{t('goals.detail.budget')}</h4>
        {goal.warnedAt80 && <Chip tone="warn">{t('goals.detail.warned80')}</Chip>}
      </div>
      <BudgetMeter spentUsd={spend.totalUsd} budgetUsd={spend.budgetUsd} />
      <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-4 text-xs min-[420px]:grid-cols-2">
        <Row label={t('goals.detail.spendForeman')} value={formatUsd(spend.foremanUsd)} />
        <Row label={t('goals.detail.spendWorkers')} value={formatUsd(spend.workerUsd)} />
        <Row label={t('goals.detail.spendGoal')} value={formatUsd(spend.goalUsd)} />
        <Row label={t('goals.detail.spendTotal')} value={formatUsd(spend.totalUsd)} />
        <Row label={t('goals.detail.replans')} value={String(goal.replans)} testId="foreman-goal-replans" />
        <Row label={t('goals.detail.judgeRuns')} value={t('goals.detail.judgeRunsValue', { runs: goal.judgeRuns, max: goal.maxRuns })} testId="foreman-goal-judge-runs" />
      </dl>
    </div>
  );
}

function GoalTimeline({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foreman');
  const [all, setAll] = useState(false);
  const entries = all ? goal.timeline : goal.timeline.slice(-TIMELINE_SHOWN);
  return (
    <div className="min-w-0 space-y-1.5">
      <h4 className={HEADING}>{t('goals.detail.timeline')}</h4>
      {goal.timeline.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">{t('goals.detail.timelineNone')}</p>
      ) : (
        <ol data-testid="foreman-goal-timeline" className="m-0 min-w-0 list-none space-y-2 border-l border-border/70 p-0 pl-3">
          {entries.map((entry, index) => (
            <li key={`${entry.ts}-${index}`} className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip>{t(`goals.timelineKind.${entry.kind}`, { defaultValue: entry.kind })}</Chip>
                <Ago iso={entry.ts} />
              </div>
              <p className="m-0 whitespace-pre-wrap break-words text-xs text-foreground">{entry.summary}</p>
              {entry.traceId && (
                <div className="flex flex-wrap items-center gap-2">
                  <TraceLink traceId={entry.traceId} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {goal.timeline.length > TIMELINE_SHOWN && (
        <button type="button" onClick={() => setAll((value) => !value)} className="min-h-10 w-full rounded-lg border border-border/60 text-xs font-medium text-foreground hover:bg-muted/60">
          {all ? t('goals.detail.showFewer') : t('goals.detail.showAll', { count: goal.timeline.length })}
        </button>
      )}
    </div>
  );
}

type GoalDetailViewProps = {
  goalId: string;
  /** The list's row for this goal, shown while the detail loads. */
  summary: GoalListItem | null;
  live: boolean;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  /** After an approval, an answer, a pause, a resume or a cancel: refresh the list, the inbox and the status bar. */
  onChanged: () => void;
};

/**
 * One goal: what it waits on (plan approval, a budget, a question) with the answers, the controls, the plan as
 * milestones of dependency-ordered tasks, the judge's verdicts, the budget and a short timeline. Polled every 5 seconds
 * while the tab is in front; a task with a queue id opens in the task detail view.
 */
export default function GoalDetailView({ goalId, summary, live, onBack, onOpenSession, onChanged }: GoalDetailViewProps) {
  const { t, i18n } = useTranslation('foreman');
  const now = useNow();
  const detail = usePolledResource(() => goalsApi.get(goalId), { enabled: live, key: goalId });
  const [openTask, setOpenTask] = useState<GoalTaskView | null>(null);
  const goal = detail.data;
  const head: GoalListItem | undefined = goal ?? summary ?? undefined;

  const changed = async () => {
    await detail.refresh();
    onChanged();
  };

  if (openTask?.taskId) {
    return (
      <TaskDetailView
        summary={{ id: openTask.taskId, title: openTask.title, repo: openTask.repo, costUsd: openTask.costUsd }}
        live={live}
        onBack={() => setOpenTask(null)}
        backLabel={t('goals.detail.backToGoal')}
        onOpenSession={onOpenSession}
        onChanged={onChanged}
      />
    );
  }

  const actions = goal ? goalActions(goal) : null;
  const next = head ? nextLine(head.next, (kind) => t(`goals.next.${kind}`)) : null;
  const deadline = head?.deadline ? formatDateTime(head.deadline, i18n.language) : '';

  return (
    <div data-testid="foreman-goal-detail" data-status={head?.status} className="min-w-0 space-y-3">
      <button type="button" onClick={onBack} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {t('goals.back')}
      </button>

      {detail.error && <LoadError error={detail.error} onRetry={() => void detail.refresh()} />}
      {!head && !detail.error && <Loading />}

      {head && (
        <>
          <div className="space-y-1.5">
            <h3 className="m-0 break-words text-sm font-semibold text-foreground">{head.title}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <GoalStatusChip status={head.status} />
              {isOverdue(head, now) && <Chip tone="bad">{t('goals.overdue')}</Chip>}
              {head.playbook && <Chip>{head.playbook}</Chip>}
              {head.repos.map((repo, index) => (
                <Chip key={repo} tone={index === 0 && head.repos.length > 1 ? 'info' : 'neutral'} title={index === 0 ? t('goals.primary') : undefined}>
                  {repoLabel(repo)}
                </Chip>
              ))}
              <Ago iso={head.updatedAt} />
            </div>
            {deadline && <p className="m-0 text-xs text-muted-foreground">{t('goals.deadline', { when: deadline })}</p>}
          </div>

          <TaskProgress goal={head} />
          <BudgetMeter spentUsd={head.spentUsd} budgetUsd={head.budgetUsd} />
          {next && isActiveGoal(head) && (
            <p data-testid="foreman-goal-next" className="m-0 break-words text-xs text-foreground">
              {t('goals.nextLine', { text: next })}
            </p>
          )}
          {head.endReason && <p className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{t('goals.endReason', { reason: head.endReason })}</p>}
        </>
      )}

      {goal && actions && (
        <>
          {actions.canApprove && <PlanApproval goal={goal} onDone={changed} />}
          <PendingAnswer goal={goal} onDone={changed} />
          {isActiveGoal(goal) && <GoalControls goal={goal} onDone={changed} />}

          <div className="space-y-1">
            <h4 className={HEADING}>{t('goals.detail.description')}</h4>
            <p className="m-0 whitespace-pre-wrap break-words text-xs text-foreground">{goal.description}</p>
          </div>
          {goal.constraints && (
            <div className="space-y-1">
              <h4 className={HEADING}>{t('goals.detail.constraints')}</h4>
              <p className="m-0 whitespace-pre-wrap break-words text-xs text-foreground">{goal.constraints}</p>
            </div>
          )}

          <GoalPlanView goal={goal} onOpenTask={setOpenTask} />
          <GoalVerdicts goal={goal} />
          <GoalBudget goal={goal} />
          <GoalTimeline goal={goal} />
          {goal.traceId && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('goals.detail.trace')}</span>
              <TraceLink traceId={goal.traceId} />
            </div>
          )}
        </>
      )}
      {!goal && head && !detail.error && <Loading />}
    </div>
  );
}

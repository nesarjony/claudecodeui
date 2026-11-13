import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ListChecks } from 'lucide-react';

import { Ago } from '@/modules/foreman/components/Bits';
import { Chip } from '@/modules/foreman/components/Chip';
import TraceLink from '@/modules/foreman/components/TraceLink';
import { formatUsd, repoLabel } from '@/modules/foreman/format';
import { GoalTaskStatusChip } from '@/modules/foreman/goals/GoalBits';
import { FIXUPS_MILESTONE, groupByMilestone, taskTitles } from '@/modules/foreman/goals/goalView';
import type { GoalDetail, GoalTaskView, GoalVerdict } from '@/modules/foreman/goals/types';

const HEADING = 'm-0 text-xs font-semibold text-foreground/80';

/** A small heading over a short list, inside an expanded row. */
function Label({ children }: { children: string }) {
  return <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/** One task of the plan: status and cost on the row; its definition of done, dependencies, summary and links when opened. */
function GoalTaskRow({ task, tasks, onOpenTask }: { task: GoalTaskView; tasks: GoalTaskView[]; onOpenTask: (task: GoalTaskView) => void }) {
  const { t } = useTranslation('foreman');
  const [open, setOpen] = useState(false);
  const after = taskTitles(task.dependsOn, tasks);

  return (
    <li data-testid="foreman-goal-task" data-key={task.key} data-status={task.status} className="min-w-0 rounded-lg border border-border/50 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
      >
        <ChevronRight className={`mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block break-words text-sm font-medium text-foreground">{task.title}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <GoalTaskStatusChip status={task.status} />
            <Chip>{t(`goals.taskKind.${task.kind}`, { defaultValue: task.kind })}</Chip>
            <Chip>{task.playbook}</Chip>
            <Chip>{repoLabel(task.repo)}</Chip>
            <Chip title={t('goals.detail.costTitle')}>{formatUsd(task.costUsd)}</Chip>
          </span>
          {after.length > 0 && <span className="block break-words text-[11px] text-muted-foreground">{t('goals.detail.after', { titles: after.join(', ') })}</span>}
        </span>
      </button>
      {open && (
        <div data-testid="foreman-goal-task-detail" className="min-w-0 space-y-2 border-t border-border/40 px-2.5 pb-2.5 pt-2 text-xs">
          {task.dod.goal && (
            <div className="space-y-0.5">
              <Label>{t('goals.detail.dodGoal')}</Label>
              <p className="m-0 whitespace-pre-wrap break-words text-foreground">{task.dod.goal}</p>
            </div>
          )}
          {task.dod.acceptanceCriteria.length > 0 && (
            <div className="space-y-0.5">
              <Label>{t('goals.detail.criteria')}</Label>
              <ul className="m-0 list-disc space-y-0.5 pl-4 text-foreground">
                {task.dod.acceptanceCriteria.map((criterion, index) => (
                  <li key={`${index}-${criterion}`} className="break-words">
                    {criterion}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {task.dod.gateCommands.length > 0 && (
            <div className="space-y-0.5">
              <Label>{t('goals.detail.gates')}</Label>
              <ul className="m-0 list-none space-y-1 p-0">
                {task.dod.gateCommands.map((command, index) => (
                  <li key={`${index}-${command}`}>
                    <code className="block break-all rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px] text-foreground">{command}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-0.5">
            <Label>{t('goals.detail.dependsOn')}</Label>
            <p className="m-0 break-words text-foreground">{after.length > 0 ? after.join(', ') : t('goals.detail.noDeps')}</p>
          </div>
          <p className="m-0 tabular-nums text-muted-foreground">{t('goals.detail.cost', { actual: formatUsd(task.costUsd), estimated: formatUsd(task.estimatedCostUsd) })}</p>
          {task.summary && (
            <div className="space-y-0.5">
              <Label>{t('goals.detail.summary')}</Label>
              <p className="m-0 whitespace-pre-wrap break-words text-foreground">{task.summary}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {task.taskId && (
              <button
                type="button"
                onClick={() => onOpenTask(task)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted"
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden />
                {t('goals.detail.openTask')}
              </button>
            )}
            {task.traceId ? <TraceLink traceId={task.traceId} /> : <span className="text-[11px] text-muted-foreground">{t('trace.none')}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

/** The plan: rationale and estimate, then each milestone with its tasks in dependency order (fix-ups last). */
export function GoalPlanView({ goal, onOpenTask }: { goal: GoalDetail; onOpenTask: (task: GoalTaskView) => void }) {
  const { t } = useTranslation('foreman');
  const groups = groupByMilestone(goal);

  return (
    <div data-testid="foreman-goal-plan" className="min-w-0 space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 className={HEADING}>{t('goals.detail.plan')}</h4>
          {goal.plan && <Chip>{t('goals.detail.planRevision', { revision: goal.plan.revision })}</Chip>}
          {goal.plan && <Chip>{t('goals.detail.estimated', { amount: formatUsd(goal.plan.estimatedCostUsd) })}</Chip>}
        </div>
        {goal.plan ? (
          <p className="m-0 whitespace-pre-wrap break-words text-xs text-foreground">{goal.plan.rationale}</p>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">{t('goals.detail.planNone')}</p>
        )}
        {goal.planNote && <p className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{t('goals.detail.planNote', { note: goal.planNote })}</p>}
      </div>

      {groups.map((group, index) => (
        <section key={group.key} data-testid="foreman-goal-milestone" data-key={group.key} aria-label={group.title || group.key} className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
            <h5 className="m-0 min-w-0 break-words text-xs font-semibold text-foreground">
              {group.title ? t('goals.detail.milestoneTitle', { n: index + 1, title: group.title }) : group.key === FIXUPS_MILESTONE ? t('goals.detail.fixups') : group.key}
            </h5>
            <span className="text-[11px] tabular-nums text-muted-foreground">{t('goals.detail.milestoneDone', { done: group.done, total: group.tasks.length })}</span>
          </div>
          {group.goal && <p className="m-0 break-words text-xs text-muted-foreground">{group.goal}</p>}
          {group.tasks.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">{t('goals.detail.noTasks')}</p>
          ) : (
            <ol className="m-0 min-w-0 list-none space-y-1.5 p-0">
              {group.tasks.map((task) => (
                <GoalTaskRow key={task.key} task={task} tasks={goal.tasks} onOpenTask={onOpenTask} />
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

function Verdict({ verdict, tasks }: { verdict: GoalVerdict; tasks: GoalTaskView[] }) {
  const { t } = useTranslation('foreman');
  const fixups = taskTitles(verdict.fixupKeys, tasks);
  return (
    <li data-testid="foreman-goal-verdict" data-passed={String(verdict.passed)} className="min-w-0 space-y-1.5 rounded-lg border border-border/50 bg-background/40 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{t('goals.detail.run', { run: verdict.run })}</Chip>
        <Chip tone={verdict.passed ? 'good' : 'bad'}>{verdict.passed ? t('goals.detail.passed') : t('goals.detail.notPassed')}</Chip>
        <Chip>{verdict.model}</Chip>
        <Chip>{formatUsd(verdict.costUsd)}</Chip>
        <Ago iso={verdict.at} />
      </div>
      {verdict.reasoning && <p className="m-0 whitespace-pre-wrap break-words text-foreground">{verdict.reasoning}</p>}
      {verdict.unmet.length > 0 && (
        <div className="space-y-0.5">
          <Label>{t('goals.detail.unmet')}</Label>
          <ul className="m-0 list-disc space-y-0.5 pl-4 text-foreground">
            {verdict.unmet.map((item, index) => (
              <li key={`${index}-${item}`} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verdict.feedback && (
        <div className="space-y-0.5">
          <Label>{t('goals.detail.feedback')}</Label>
          <p className="m-0 whitespace-pre-wrap break-words text-foreground">{verdict.feedback}</p>
        </div>
      )}
      {fixups.length > 0 && (
        <div className="space-y-0.5">
          <Label>{t('goals.detail.fixupsAdded')}</Label>
          <ul className="m-0 list-disc space-y-0.5 pl-4 text-foreground">
            {fixups.map((title, index) => (
              <li key={`${index}-${title}`} className="break-words">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {verdict.traceId ? <TraceLink traceId={verdict.traceId} /> : <span className="text-[11px] text-muted-foreground">{t('trace.none')}</span>}
      </div>
    </li>
  );
}

/** The goal judge's runs, oldest first. */
export function GoalVerdicts({ goal }: { goal: GoalDetail }) {
  const { t } = useTranslation('foreman');
  return (
    <div data-testid="foreman-goal-verdicts" className="min-w-0 space-y-1.5">
      <h4 className={HEADING}>{t('goals.detail.verdicts')}</h4>
      {goal.verdicts.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">{t('goals.detail.verdictsNone')}</p>
      ) : (
        <ol className="m-0 min-w-0 list-none space-y-1.5 p-0">
          {goal.verdicts.map((verdict) => (
            <Verdict key={verdict.run} verdict={verdict} tasks={goal.tasks} />
          ))}
        </ol>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/shared/ui';
import { foremanTabApi } from '@/modules/foreman/api';
import { Ago, Empty, LoadError, Loading, SessionLink } from '@/modules/foreman/components/Bits';
import { statusTone } from '@/modules/foreman/chipTone';
import { Chip } from '@/modules/foreman/components/Chip';
import ConfirmDialog from '@/modules/foreman/components/ConfirmDialog';
import TraceLink from '@/modules/foreman/components/TraceLink';
import { formatUsd, repoLabel } from '@/modules/foreman/format';
import { dodItems, isActiveTask, lastDecisionLine } from '@/modules/foreman/taskView';
import { usePolledResource, type PolledResource } from '@/modules/foreman/usePolledResource';
import type { TaskDetail, TaskSummary } from '@/modules/foreman/types';

type Filter = 'all' | 'active' | 'finished';
const FILTERS: Filter[] = ['all', 'active', 'finished'];
const SHOWN = 50;

function StatusChip({ status }: { status: string | undefined }) {
  const { t } = useTranslation('foreman');
  return <Chip tone={statusTone(status)}>{t(`tasks.status.${status ?? 'unknown'}`, { defaultValue: status ?? t('tasks.status.unknown') })}</Chip>;
}

/** One task: its definition of done, timeline, session and take-over. Also opened from a goal's task list. */
export function TaskDetailView({
  summary,
  live,
  onBack,
  backLabel,
  onOpenSession,
  onChanged,
}: {
  summary: TaskSummary;
  live: boolean;
  onBack: () => void;
  /** The back button's label (default "All tasks"). */
  backLabel?: string;
  onOpenSession: (sessionId: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('foreman');
  const detail = usePolledResource<TaskDetail>(() => foremanTabApi.task(summary.id), { enabled: live, key: summary.id });
  const [confirming, setConfirming] = useState(false);
  const task = detail.data ?? summary;
  const dod = dodItems(detail.data?.dod);
  const timeline = detail.data?.timeline ?? [];
  const canTakeOver = isActiveTask(task);

  return (
    <div data-testid="foreman-task-detail" className="min-w-0 space-y-3">
      <button type="button" onClick={onBack} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {backLabel ?? t('tasks.back')}
      </button>
      <div className="space-y-1.5">
        <h3 className="m-0 break-words text-sm font-semibold text-foreground">{task.title ?? task.id}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={task.status} />
          {task.repo && <Chip>{repoLabel(task.repo)}</Chip>}
          {task.playbook && <Chip>{task.playbook}</Chip>}
          {typeof task.costUsd === 'number' && <Chip>{formatUsd(task.costUsd)}</Chip>}
        </div>
      </div>

      {detail.error && <LoadError error={detail.error} onRetry={() => void detail.refresh()} />}

      <div className="space-y-1.5">
        <h4 className="m-0 text-xs font-semibold text-foreground/80">{t('tasks.dod')}</h4>
        {dod.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">{detail.loading ? t('common.loading') : t('tasks.dodNone')}</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0" data-testid="foreman-dod">
            {dod.map((item, index) => (
              <li key={`${index}-${item.text}`} className="flex min-w-0 items-start gap-2 text-xs">
                <span aria-hidden className={`mt-0.5 shrink-0 ${item.met === true ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                  {item.met === true ? '✓' : '○'}
                </span>
                <span className="min-w-0 break-words text-foreground">{item.text}</span>
                {item.met !== null && <span className="sr-only">{item.met ? t('tasks.met') : t('tasks.notMet')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <h4 className="m-0 text-xs font-semibold text-foreground/80">{t('tasks.timeline')}</h4>
        {timeline.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">{detail.loading ? t('common.loading') : t('tasks.timelineNone')}</p>
        ) : (
          <ol className="m-0 min-w-0 list-none space-y-2 border-l border-border/70 p-0 pl-3" data-testid="foreman-timeline">
            {timeline.map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={entry.kind === 'needs_user' ? 'warn' : entry.kind === 'gate' || entry.kind === 'judge' ? 'info' : 'neutral'}>
                    {t(`tasks.kind.${entry.kind}`, { defaultValue: entry.kind })}
                  </Chip>
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {task.sessionId && <SessionLink sessionId={task.sessionId} onOpen={onOpenSession} />}
        {canTakeOver && (
          <Button variant="outline" className="h-10" onClick={() => setConfirming(true)}>
            {t('tasks.takeover')}
          </Button>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          open
          title={t('tasks.takeoverTitle')}
          description={t('tasks.takeoverBody')}
          confirmLabel={t('tasks.takeover')}
          onConfirm={async () => {
            await foremanTabApi.takeover(summary.id);
            await detail.refresh();
            onChanged();
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

type TasksSectionProps = {
  tasks: PolledResource<TaskSummary[]>;
  live: boolean;
  onOpenSession: (sessionId: string) => void;
  /** After a take-over: refresh the counts in the status bar. */
  onChanged: () => void;
};

/** Active and recent tasks. Tap one for its Definition of Done, its timeline and the take-over button. */
export default function TasksSection({ tasks, live, onOpenSession, onChanged }: TasksSectionProps) {
  const { t } = useTranslation('foreman');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<TaskSummary | null>(null);

  if (selected) {
    const fresh = tasks.data?.find((task) => task.id === selected.id) ?? selected;
    return <TaskDetailView summary={fresh} live={live} onBack={() => setSelected(null)} onOpenSession={onOpenSession} onChanged={() => { void tasks.refresh(); onChanged(); }} />;
  }

  const shown = (tasks.data ?? []).filter((task) => (filter === 'all' ? true : filter === 'active' ? isActiveTask(task) : !isActiveTask(task))).slice(0, SHOWN);

  return (
    <>
      <div role="radiogroup" aria-label={t('tasks.filterLabel')} className="grid grid-cols-3 rounded-lg border border-border/60 bg-muted/40 p-0.5">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => setFilter(value)}
            className={`min-h-10 rounded-md text-xs font-medium transition-colors ${filter === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(`tasks.filter.${value}`)}
          </button>
        ))}
      </div>
      {tasks.error && <LoadError error={tasks.error} onRetry={() => void tasks.refresh()} />}
      {!tasks.data && !tasks.error && <Loading />}
      {tasks.data && shown.length === 0 && <Empty>{t(filter === 'all' ? 'tasks.empty' : 'tasks.emptyFiltered')}</Empty>}
      {shown.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-1.5 p-0">
          {shown.map((task) => {
            const last = lastDecisionLine(task.lastDecision);
            return (
              <li key={task.id} data-testid="foreman-task" data-status={task.status} className="min-w-0 rounded-lg border border-border/50 bg-background/40">
                <button
                  type="button"
                  onClick={() => setSelected(task)}
                  className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block break-words text-sm font-medium text-foreground">{task.title ?? task.id}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <StatusChip status={task.status} />
                      {task.repo && <Chip>{repoLabel(task.repo)}</Chip>}
                      {typeof task.costUsd === 'number' && <Chip>{formatUsd(task.costUsd)}</Chip>}
                      <Ago iso={task.updatedAt} />
                    </span>
                    {last && <span className="line-clamp-2 block break-words text-xs text-muted-foreground">{last}</span>}
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
                {task.sessionId && (
                  <div className="px-2.5 pb-2">
                    <SessionLink sessionId={task.sessionId} onOpen={onOpenSession} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

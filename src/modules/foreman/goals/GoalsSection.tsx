import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus } from 'lucide-react';

import { Empty, LoadError, Loading } from '@/modules/foreman/components/Bits';
import GoalCard from '@/modules/foreman/goals/GoalCard';
import GoalDetailView from '@/modules/foreman/goals/GoalDetail';
import GoalForm from '@/modules/foreman/goals/GoalForm';
import { EMPTY_GOAL_FORM, type GoalForm as GoalFormValues } from '@/modules/foreman/goals/goalView';
import type { GoalListItem } from '@/modules/foreman/goals/types';
import type { PolledResource } from '@/modules/foreman/usePolledResource';

const SHOWN = 50;

type GoalsSectionProps = {
  goals: PolledResource<GoalListItem[]>;
  live: boolean;
  /** The goal whose detail is open (held by the panel, so a needs-you item can open it too). */
  selectedId: string | null;
  onSelect: (goalId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  /** After a change (a new goal, an approval, an answer, a pause): refresh the inbox and the status bar. */
  onChanged: () => void;
};

/**
 * Goals: big objectives Foreman breaks into milestones and tasks. A form to start one, the list with progress, spend
 * and what comes next, and a detail view per goal (plan approval, controls, tasks, verdicts, budget).
 */
export default function GoalsSection({ goals, live, selectedId, onSelect, onOpenSession, onChanged }: GoalsSectionProps) {
  const { t } = useTranslation('foreman');
  const [creating, setCreating] = useState(false);
  // The draft outlives a fold of the form; it is cleared once the goal is created.
  const [draft, setDraft] = useState<GoalFormValues>(EMPTY_GOAL_FORM);

  if (selectedId) {
    return (
      <GoalDetailView
        key={selectedId}
        goalId={selectedId}
        summary={goals.data?.find((goal) => goal.id === selectedId) ?? null}
        live={live}
        onBack={() => onSelect(null)}
        onOpenSession={onOpenSession}
        onChanged={() => {
          void goals.refresh();
          onChanged();
        }}
      />
    );
  }

  const shown = (goals.data ?? []).slice(0, SHOWN);

  return (
    <>
      <button
        type="button"
        onClick={() => setCreating((value) => !value)}
        aria-expanded={creating}
        aria-controls="foreman-goal-form"
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
      >
        <Plus className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('goals.new')}</span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${creating ? 'rotate-90' : ''}`} aria-hidden />
      </button>
      {creating && (
        <div id="foreman-goal-form" className="min-w-0">
          <GoalForm
            form={draft}
            onChange={setDraft}
            live={live}
            onClose={() => setCreating(false)}
            onCreated={(goal) => {
              setDraft(EMPTY_GOAL_FORM);
              setCreating(false);
              void goals.refresh();
              onChanged();
              onSelect(goal.id);
            }}
          />
        </div>
      )}

      {goals.error && <LoadError error={goals.error} onRetry={() => void goals.refresh()} />}
      {!goals.data && !goals.error && <Loading />}
      {goals.data && goals.data.length === 0 && <Empty>{t('goals.empty')}</Empty>}
      {shown.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-1.5 p-0">
          {shown.map((goal) => (
            <GoalCard key={goal.id} goal={goal} onOpen={onSelect} />
          ))}
        </ul>
      )}
    </>
  );
}

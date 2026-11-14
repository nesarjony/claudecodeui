import { useTranslation } from 'react-i18next';

import type { GoalDetail } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

/** Used by the goal page for the goal's title, state and "done when", with Pause or Resume and Re-plan. */
export function GoalHeader({ goal, onChanged }: { goal: GoalDetail; onChanged: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const change = async (task: () => Promise<unknown>) => {
    if (await run(task)) onChanged();
  };
  return (
    <header className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{goal.title}</h1>
        <div className="flex items-center gap-2">
          <Chip tone={goal.state === 'active' ? 'good' : 'neutral'}>{t(`work.state.${goal.state}`)}</Chip>
          {goal.state === 'paused' ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => api.resumeGoal(goal.id))}>
              {t('work.resume')}
            </Button>
          ) : goal.state === 'active' ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => api.pauseGoal(goal.id))}>
              {t('work.pause')}
            </Button>
          ) : null}
          {goal.hasStrategy && goal.state !== 'done' ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => api.replanGoal(goal.id))}>
              {t('work.replan')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('work.doneWhen', { text: goal.doneWhen })}</p>
      {failed ? <InlineError /> : null}
    </header>
  );
}

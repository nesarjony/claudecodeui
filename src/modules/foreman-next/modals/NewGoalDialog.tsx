import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { NativeSelect } from '@/modules/foreman-next/components/NativeSelect';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { parseBudgetInput } from '@/modules/foreman-next/utils/goalLimits';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

/** Used by the Work board and the no-goals state for the first two steps of a new goal (wireframes §14); Foreman then studies the repo and its strategy waits on the goal page for approval. */
export function NewGoalDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const navigate = useNavigate();
  const repos = useForemanResource((foreman) => foreman.repos());
  const { busy, failed, run } = useAction();
  // Which repo the goal is for, if the owner changed it from the first one; and what "done" means for it.
  const [chosenRepo, setChosenRepo] = useState('');
  const [goal, setGoal] = useState('');
  // The two optional limits, as typed: how the owner will know it is done, and the most it may cost.
  const [successMeasure, setSuccessMeasure] = useState('');
  const [budget, setBudget] = useState('');
  const typedBudget = parseBudgetInput(budget);

  const create = async (repo: string, event: FormEvent) => {
    event.preventDefault();
    if (typedBudget.kind === 'invalid') return;
    // Only what the owner filled in goes with the request: a goal with neither is the request Foreman has always had.
    const request = { repo, goal: goal.trim(), ...(successMeasure.trim() === '' ? {} : { successMeasure: successMeasure.trim() }), ...(typedBudget.kind === 'ok' ? { budgetUsd: typedBudget.value } : {}) };
    const created = await run(() => api.createGoal(request));
    if (created.ok) {
      onClose();
      navigate(foremanPath.goal(created.value.id));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5">
        <DialogTitle className="not-sr-only mb-4 text-base font-semibold">{t('work.newGoal')}</DialogTitle>
        <ResourceView resource={repos} isEmpty={(items) => items.length === 0} empty={<p className="text-sm text-muted-foreground">{t('work.noRepos')}</p>}>
          {(items) => {
            const repo = chosenRepo || items[0]?.name || '';
            return (
              <form onSubmit={(event) => void create(repo, event)} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="new-goal-repo" className="text-sm font-medium">
                    {t('work.repo')}
                  </label>
                  <NativeSelect id="new-goal-repo" value={repo} onChange={(event) => setChosenRepo(event.target.value)} className="w-full">
                    {items.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <label htmlFor="new-goal-text" className="text-sm font-medium">
                    {t('work.goalText')}
                  </label>
                  <Input id="new-goal-text" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('work.goalPlaceholder')} />
                  <p className="text-xs text-muted-foreground">{t('work.goalHint')}</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="new-goal-measure" className="text-sm font-medium">
                    {t('work.successMeasure')}
                  </label>
                  <Input id="new-goal-measure" value={successMeasure} onChange={(event) => setSuccessMeasure(event.target.value)} placeholder={t('work.successMeasurePlaceholder')} />
                  <p className="text-xs text-muted-foreground">{t('work.successMeasureHint')}</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="new-goal-budget" className="text-sm font-medium">
                    {t('work.budget')}
                  </label>
                  <Input
                    id="new-goal-budget"
                    value={budget}
                    inputMode="decimal"
                    placeholder="60"
                    aria-invalid={typedBudget.kind === 'invalid'}
                    aria-describedby="new-goal-budget-hint"
                    onChange={(event) => setBudget(event.target.value)}
                    className="w-40"
                  />
                  <p id="new-goal-budget-hint" className={typedBudget.kind === 'invalid' ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-muted-foreground'}>
                    {typedBudget.kind === 'invalid' ? t(`work.limits.error.${typedBudget.reason}`) : t('work.budgetHint')}
                  </p>
                </div>
                {failed ? <InlineError /> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" size="sm" disabled={busy || goal.trim() === '' || typedBudget.kind === 'invalid'}>
                    {t('work.createGoal')}
                  </Button>
                </div>
              </form>
            );
          }}
        </ResourceView>
      </DialogContent>
    </Dialog>
  );
}

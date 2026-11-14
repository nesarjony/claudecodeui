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

  const create = async (repo: string, event: FormEvent) => {
    event.preventDefault();
    const created = await run(() => api.createGoal({ repo, goal: goal.trim() }));
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
                {failed ? <InlineError /> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" size="sm" disabled={busy || goal.trim() === ''}>
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

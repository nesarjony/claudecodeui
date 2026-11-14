import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

/** Used by the Work board and the no-goals state for the first two steps of a new goal (wireframes §14); Foreman's study and strategy then wait on the goal page for approval. */
export function NewGoalDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const navigate = useNavigate();
  const { busy, failed, run } = useAction();
  // The two fields of the form: which repo, and what "done" means for it.
  const [repo, setRepo] = useState('');
  const [goal, setGoal] = useState('');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const created: { id?: string } = {};
    const saved = await run(async () => {
      created.id = (await api.createGoal({ repo: repo.trim(), goal: goal.trim() })).id;
    });
    if (saved && created.id) {
      onClose();
      navigate(foremanPath.goal(created.id));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5">
        <form onSubmit={(event) => void create(event)} className="space-y-4">
          <DialogTitle className="not-sr-only text-base font-semibold">{t('work.newGoal')}</DialogTitle>
          <div className="space-y-1">
            <label htmlFor="new-goal-repo" className="text-sm font-medium">
              {t('work.repo')}
            </label>
            <Input id="new-goal-repo" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="desk" />
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
            <Button type="submit" size="sm" disabled={busy || repo.trim() === '' || goal.trim() === ''}>
              {t('work.createGoal')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

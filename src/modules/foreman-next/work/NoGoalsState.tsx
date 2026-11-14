import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { NewGoalDialog } from '@/modules/foreman-next/work/NewGoalDialog';
import { Button } from '@/shared/ui';

/** Used by the Today screen and the Work board when Foreman has no goals yet: an example and the New goal flow (wireframes §15). */
export function NoGoalsState() {
  const { t } = useTranslation('foremanNext');
  // Whether the New goal dialog is open.
  const [creating, setCreating] = useState(false);
  return (
    <EmptyState title={t('work.noGoalsTitle')} body={t('work.noGoalsBody')}>
      <Button size="sm" onClick={() => setCreating(true)}>
        {t('work.newGoal')}
      </Button>
      {creating ? <NewGoalDialog onClose={() => setCreating(false)} /> : null}
    </EmptyState>
  );
}

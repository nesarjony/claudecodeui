import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { SupervisedBanner } from '@/modules/foreman-next/handover/SupervisedBanner';
import { WorkerBanner } from '@/modules/foreman-next/handover/WorkerBanner';
import { HandOverDialog } from '@/modules/foreman-next/modals/HandOverDialog';
import { Button } from '@/shared/ui';

/** Used by SessionBarEntry for a session's supervision: the Foreman worker banner, "Hand to Foreman" while an owner session is the owner's, and the supervision banner with "Take back" once Foreman has it. */
export function SessionSupervisionBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('foremanNext');
  const supervision = useForemanResource((api) => api.sessionSupervision(sessionId), { key: sessionId });
  // Whether the hand-over dialog is open.
  const [handingOver, setHandingOver] = useState(false);
  const state = supervision.data;

  if (!state) return null;
  if (state.state === 'worker') return <WorkerBanner {...state} />;
  if (state.state === 'handed-over') return <SupervisedBanner sessionId={sessionId} runId={state.runId} goal={state.goal} />;
  return (
    <div className="flex shrink-0 justify-end border-b border-border/60 px-3 py-1">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setHandingOver(true)}>
        {t('handover.button')}
      </Button>
      {handingOver ? <HandOverDialog sessionId={sessionId} onClose={() => setHandingOver(false)} /> : null}
    </div>
  );
}

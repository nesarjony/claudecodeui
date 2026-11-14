import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { HandOverDialog } from '@/modules/foreman-next/handover/HandOverDialog';
import { SupervisedBanner } from '@/modules/foreman-next/handover/SupervisedBanner';
import { Button } from '@/shared/ui';

const SUPERVISION_POLL_MS = 15_000;

/** Used by ForemanSessionBar for the owner's own session: "Hand to Foreman" while it is theirs, the supervision banner with "Take back" once Foreman has it. */
export function SessionSupervisionBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('foremanNext');
  const supervision = useForemanResource((api) => api.sessionSupervision(sessionId), { key: sessionId, pollMs: SUPERVISION_POLL_MS });
  // Whether the hand-over dialog is open.
  const [handingOver, setHandingOver] = useState(false);
  const state = supervision.data;

  if (!state || state.state === 'worker') return null;
  if (state.state === 'handed-over') {
    return <SupervisedBanner sessionId={sessionId} runId={state.runId} goal={state.goal} onTakenBack={() => void supervision.refresh()} />;
  }
  return (
    <div className="flex shrink-0 justify-end border-b border-border/60 px-3 py-1">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setHandingOver(true)}>
        {t('handover.button')}
      </Button>
      {handingOver ? <HandOverDialog sessionId={sessionId} onClose={() => setHandingOver(false)} onHandedOver={() => void supervision.refresh()} /> : null}
    </div>
  );
}

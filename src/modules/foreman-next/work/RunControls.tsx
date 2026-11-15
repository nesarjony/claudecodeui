import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';

import { RUN_STAGE_IDS } from '@/modules/foreman-next/api/contract';
import type { RunDetail, RunStageId } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { NativeSelect } from '@/modules/foreman-next/components/NativeSelect';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

/** Used by the run header for Pause or Resume, Stop, Take over (or Take back for a handed-over session) and Replay from a step. */
export function RunControls({ run }: { run: RunDetail }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const navigate = useNavigate();
  const { busy, failed, run: perform } = useAction();
  // The stage chosen in the "Replay from step" list; the replay starts only when the owner presses Replay.
  const [replayFrom, setReplayFrom] = useState<RunStageId | ''>('');
  const active = run.state === 'running' || run.state === 'paused';
  const handedOver = run.kind === 'handed-over';

  const takeOver = async () => {
    const taken = await perform(() => api.takeOverRun(run.id));
    if (taken.ok && run.sessionId) navigate(foremanPath.session(run.sessionId));
  };

  const chooseStage = (event: ChangeEvent<HTMLSelectElement>) => setReplayFrom(RUN_STAGE_IDS.find((stage) => stage === event.target.value) ?? '');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {active ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => (run.state === 'paused' ? api.resumeRun(run.id) : api.pauseRun(run.id)))}>
          {t(run.state === 'paused' ? 'run.resume' : 'run.pause')}
        </Button>
      ) : null}
      {active && !handedOver ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => api.stopRun(run.id))}>
          {t('run.stop')}
        </Button>
      ) : null}
      {active && !handedOver && run.control === 'foreman' ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void takeOver()}>
          {t('run.takeOver')} ↗
        </Button>
      ) : null}
      {active && handedOver && run.sessionId ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => api.takeBackSession(run.sessionId ?? ''))}>
          {t('run.takeBack')}
        </Button>
      ) : null}
      {!handedOver ? (
        <span className="flex items-center gap-1">
          <NativeSelect aria-label={t('run.replayFrom')} value={replayFrom} onChange={chooseStage}>
            <option value="">{t('run.replayFrom')}</option>
            {run.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {t(`run.stage.${stage.id}`)}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" disabled={busy || replayFrom === ''} onClick={() => replayFrom && void perform(() => api.replayRun(run.id, replayFrom))}>
            {t('run.replay')}
          </Button>
        </span>
      ) : null}
      {failed ? <InlineError /> : null}
    </div>
  );
}

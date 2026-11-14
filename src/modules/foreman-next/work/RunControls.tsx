import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';

import type { RunDetail, RunStageId } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

/** Used by the run header for Pause or Resume, Stop, Take over (or Take back for a handed-over session) and Replay from a step. */
export function RunControls({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const navigate = useNavigate();
  const { busy, failed, run: perform } = useAction();
  // The stage chosen in the "Replay from step" list; the replay starts only when the owner presses Replay.
  const [replayFrom, setReplayFrom] = useState<RunStageId | ''>('');
  const active = run.state === 'running' || run.state === 'paused';
  const handedOver = run.kind === 'handed-over';

  const change = async (task: () => Promise<unknown>) => {
    if (await perform(task)) onChanged();
  };

  const takeOver = async () => {
    if (await perform(() => api.takeOverRun(run.id))) {
      onChanged();
      if (run.sessionId) navigate(`/session/${run.sessionId}`);
    }
  };

  const chooseStage = (event: ChangeEvent<HTMLSelectElement>) => setReplayFrom(event.target.value as RunStageId | '');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {active ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => (run.state === 'paused' ? api.resumeRun(run.id) : api.pauseRun(run.id)))}>
          {t(run.state === 'paused' ? 'run.resume' : 'run.pause')}
        </Button>
      ) : null}
      {active && !handedOver ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => api.stopRun(run.id))}>
          {t('run.stop')}
        </Button>
      ) : null}
      {active && !handedOver && run.control === 'foreman' ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void takeOver()}>
          {t('run.takeOver')} ↗
        </Button>
      ) : null}
      {active && handedOver && run.sessionId ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(() => api.takeBackSession(run.sessionId ?? ''))}>
          {t('run.takeBack')}
        </Button>
      ) : null}
      {!handedOver ? (
        <span className="flex items-center gap-1">
          <select aria-label={t('run.replayFrom')} value={replayFrom} onChange={chooseStage} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
            <option value="">{t('run.replayFrom')}</option>
            {run.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {t(`run.stage.${stage.id}`)}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={busy || replayFrom === ''} onClick={() => replayFrom && void change(() => api.replayRun(run.id, replayFrom))}>
            {t('run.replay')}
          </Button>
        </span>
      ) : null}
      {failed ? <InlineError /> : null}
    </div>
  );
}

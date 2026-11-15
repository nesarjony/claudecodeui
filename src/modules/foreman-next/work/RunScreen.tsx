import { useParams } from 'react-router-dom';

import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { RunDecisionsPanel } from '@/modules/foreman-next/work/RunDecisionsPanel';
import { RunHeader } from '@/modules/foreman-next/work/RunHeader';
import { RunVerdictPanel } from '@/modules/foreman-next/work/RunVerdictPanel';
import { RunWorkerPanel } from '@/modules/foreman-next/work/RunWorkerPanel';

/** Used by ForemanNextRoutes for the live run view (wireframes §6c): stages, Foreman's decisions, what the worker does, and the checks and verdict. */
export function RunScreen() {
  const { runId = '' } = useParams();
  const run = useForemanResource((api) => api.run(runId), { key: runId, keepPolling: (data) => data.state === 'running' || data.state === 'paused' });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ResourceView resource={run}>
        {(data) => (
          <>
            <h1 className="sr-only">{data.batch}</h1>
            <RunHeader run={data} />
            <div className="grid gap-4 md:grid-cols-2">
              <RunDecisionsPanel decisions={data.decisions} />
              <RunWorkerPanel run={data} />
            </div>
            <RunVerdictPanel verdict={data.verdict} />
          </>
        )}
      </ResourceView>
    </div>
  );
}

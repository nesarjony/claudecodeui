import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';

import type { RepoSettings } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { RepoForm } from '@/modules/foreman-next/settings/RepoForm';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';
import { Button } from '@/shared/ui';

/** Used by the Repos panel for one registered repo: what the owner registered, what its adapter says of it, the switch that lets workers start on a read-only one, and Change. */
export function RepoRow({ repo }: { repo: RepoSettings }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, message, failed, run } = useAction();
  // Whether the change form is open in place of the repo's lines.
  const [changing, setChanging] = useState(false);
  const readOnly = repo.mode === 'read-only';

  const turn = (event: ChangeEvent<HTMLInputElement>) => void run(() => api.setRepoWorkers(repo.name, event.target.checked));

  if (changing) return <RepoForm repo={repo} onDone={() => setChanging(false)} />;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{repo.name}</span>
          <span className="text-muted-foreground">{repo.directory}</span>
          {readOnly ? <Chip tone="warn">{t('repos.readOnly')}</Chip> : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
          {t('repos.changeButton')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {[
          t('repos.adapterLine', { adapter: repo.adapter, branch: repo.baseBranch }),
          t('repos.checks', { command: repo.checks }),
          t('repos.protected', { count: repo.protectedPaths }),
          t('repos.pinned', { count: repo.pinned }),
          repo.indexedAt ? t('repos.indexed', { clock: formatClock(repo.indexedAt) }) : t('repos.notIndexed'),
        ].join(' · ')}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={repo.workers || !readOnly} disabled={busy || !readOnly} onChange={turn} />
        <span>{readOnly ? t('repos.workersFor', { name: repo.name }) : t('repos.workersAlways', { name: repo.name })}</span>
      </label>
      {failed ? <InlineError message={message} /> : null}
    </div>
  );
}

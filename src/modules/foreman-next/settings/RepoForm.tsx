import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { RepoSettings } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Input } from '@/shared/ui';

type RepoFormProps = { repo?: RepoSettings; onDone?: () => void };

/** Used by the Repos panel to add a repo (its name, where it is and which adapter reads it) and to change one already registered; the branch is the repo's checked-out one when left empty. */
export function RepoForm({ repo, onDone }: RepoFormProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, message, failed, run } = useAction();
  // What the owner has typed so far: a repo being changed starts from what is registered.
  const [name, setName] = useState(repo?.name ?? '');
  const [directory, setDirectory] = useState(repo?.directory ?? '');
  const [adapter, setAdapter] = useState(repo?.adapter ?? '');
  const [branch, setBranch] = useState(repo?.baseBranch ?? '');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await run(() => api.setRepo(name.trim(), { directory: directory.trim(), adapter: adapter.trim(), baseBranch: branch.trim() === '' ? null : branch.trim() }));
    if (!saved.ok) return;
    if (repo === undefined) {
      setName('');
      setDirectory('');
      setAdapter('');
      setBranch('');
    }
    onDone?.();
  };

  return (
    <form onSubmit={(event) => void save(event)} className="grid gap-2 sm:grid-cols-2" aria-label={repo === undefined ? t('repos.add') : t('repos.change', { name: repo.name })}>
      {repo === undefined ? (
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('repos.name')}</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      ) : null}
      <label className="space-y-1 text-sm">
        <span className="font-medium">{t('repos.directory')}</span>
        <Input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/mnt/dev/…" />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium">{t('repos.adapter')}</span>
        <Input value={adapter} onChange={(event) => setAdapter(event.target.value)} placeholder="desk" />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium">{t('repos.branch')}</span>
        <Input value={branch} onChange={(event) => setBranch(event.target.value)} />
      </label>
      <div className="flex items-end justify-end gap-2 sm:col-span-2">
        {failed ? <InlineError message={message} /> : null}
        {repo === undefined ? null : (
          <Button type="button" variant="outline" size="sm" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || directory.trim() === '' || adapter.trim() === '' || name.trim() === ''}>
          {repo === undefined ? t('repos.addButton') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

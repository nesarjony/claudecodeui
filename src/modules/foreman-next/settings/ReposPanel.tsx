import { useTranslation } from 'react-i18next';

import type { RepoSettings } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { RepoForm } from '@/modules/foreman-next/settings/RepoForm';
import { RepoRow } from '@/modules/foreman-next/settings/RepoRow';

/** Used by the Settings screen for the registry of repos Foreman works on (wireframes §11): each repo as the owner registered it, the switch for workers on a read-only one, and the form that adds a repo. Only the owner writes any of it. */
export function ReposPanel({ repos }: { repos: RepoSettings[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('repos.title')}>
      <div className="space-y-4">
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('repos.none')}</p>
        ) : (
          <ul className="space-y-3">
            {repos.map((repo) => (
              <li key={repo.name} className="border-b pb-3 last:border-b-0 last:pb-0">
                <RepoRow repo={repo} />
              </li>
            ))}
          </ul>
        )}
        <RepoForm />
      </div>
    </Panel>
  );
}

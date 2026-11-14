import { useTranslation } from 'react-i18next';

import type { ForemanSettings, RepoSettings } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { formatClock, formatUsd } from '@/modules/foreman-next/utils/foremanFormat';

type SettingsFactsProps = { settings: ForemanSettings; repos: RepoSettings[]; editorUrl: string | null };

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Used by the Settings screen for the lines the owner reads but does not change here (wireframes §11): budget, MiniMax, models, roles and repos. */
export function SettingsFacts({ settings, repos, editorUrl }: SettingsFactsProps) {
  const { t } = useTranslation('foremanNext');
  const { budget, minimax, models, roles } = settings;
  return (
    <Panel title={t('facts.title')}>
      <dl className="space-y-2">
        <Fact label={t('facts.budget')}>
          {[t('facts.budgetLine', { monthly: formatUsd(budget.monthlyUsd), pace: formatUsd(budget.paceUsdPerDay) }), ...budget.goalShares.map((share) => t('facts.share', { goal: share.goal, usd: formatUsd(share.usd) }))].join(' · ')}
        </Fact>
        <Fact label={t('facts.minimax')}>{t(minimax.autoResume ? 'facts.minimaxResume' : 'facts.minimaxStay', { pct: minimax.stopAtPct })}</Fact>
        <Fact label={t('facts.models')}>{[models.foremanRoles, models.workers, models.sideRuns].join(' · ')}</Fact>
        <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6rem_1fr]">
          <dt className="text-sm text-muted-foreground">{t('facts.roles')}</dt>
          <dd className="text-sm">
            {roles.map((role) => `${role.name} v${role.version}`).join(' · ')}
            {editorUrl ? (
              <a href={editorUrl} target="_blank" rel="noreferrer" className="ml-3 text-primary hover:underline">
                {t('facts.editor')} ↗
              </a>
            ) : null}
          </dd>
        </div>
        {repos.map((repo) => (
          <Fact key={repo.name} label={t('facts.repo', { name: repo.name })}>
            {[t('facts.checks', { command: repo.checks }), t('facts.protected', { count: repo.protectedPaths }), repo.indexedAt ? t('facts.indexed', { clock: formatClock(repo.indexedAt) }) : t('facts.notIndexed')].join(' · ')}
          </Fact>
        ))}
      </dl>
    </Panel>
  );
}

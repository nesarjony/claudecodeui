import { useTranslation } from 'react-i18next';

import type { ForemanSettings } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { formatUsd } from '@/modules/foreman-next/utils/foremanFormat';

type SettingsFactsProps = { settings: ForemanSettings; editorUrl: string | null };

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Used by the Settings screen for the lines the owner reads but does not change here (wireframes §11): budget, plan window, models and roles. */
export function SettingsFacts({ settings, editorUrl }: SettingsFactsProps) {
  const { t } = useTranslation('foremanNext');
  const { budget, minimax, models, roles } = settings;
  // The contract keeps the old `minimax` name for the plan window. No plan watched is a stop at the whole of it (Foreman reads that as 100), and nothing stops a worker before its route does.
  const watched = minimax.stopAtPct < 100;
  const planWindow = watched ? t(minimax.autoResume ? 'facts.planWindowResume' : 'facts.planWindowStay', { pct: minimax.stopAtPct }) : t('facts.planWindowNone');
  return (
    <Panel title={t('facts.title')}>
      <dl className="space-y-2">
        <Fact label={t('facts.budget')}>
          {[t('facts.budgetLine', { monthly: formatUsd(budget.monthlyUsd), pace: formatUsd(budget.paceUsdPerDay) }), ...budget.goalShares.map((share) => t('facts.share', { goal: share.goal, usd: formatUsd(share.usd) }))].join(' · ')}
        </Fact>
        <Fact label={t('facts.planWindow')}>{planWindow}</Fact>
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
      </dl>
    </Panel>
  );
}

import { useTranslation } from 'react-i18next';

import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { useForemanStatus } from '@/modules/foreman-next/hooks/useForemanStatus';
import { AttentionForm } from '@/modules/foreman-next/settings/AttentionForm';
import { DelegationTable } from '@/modules/foreman-next/settings/DelegationTable';
import { ReposPanel } from '@/modules/foreman-next/settings/ReposPanel';
import { SettingsFacts } from '@/modules/foreman-next/settings/SettingsFacts';

/** Used by ForemanNextRoutes for Settings (wireframes §11 and §13): the trust ladder per kind of decision, the read-only lines of budget and models, the registry of repos, and the attention policy. */
export function SettingsScreen() {
  const { t } = useTranslation('foremanNext');
  const delegation = useForemanResource((api) => api.delegation());
  const attention = useForemanResource((api) => api.attention());
  const settings = useForemanResource((api) => api.settings());
  const repos = useForemanResource((api) => api.repos());
  const { data: status } = useForemanStatus();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="sr-only">{t('nav.settings')}</h1>
      <DelegationTable delegation={delegation} />
      <ResourceView resource={settings}>{(facts) => <SettingsFacts settings={facts} editorUrl={status?.studioUrl ?? null} />}</ResourceView>
      <ResourceView resource={repos}>{(items) => <ReposPanel repos={items} />}</ResourceView>
      <Panel title={t('attention.title')}>
        <ResourceView resource={attention}>{(policy) => <AttentionForm policy={policy} />}</ResourceView>
      </Panel>
    </div>
  );
}

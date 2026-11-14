import { useTranslation } from 'react-i18next';

import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { AttentionForm } from '@/modules/foreman-next/settings/AttentionForm';
import { DelegationTable } from '@/modules/foreman-next/settings/DelegationTable';

/** Used by ForemanNextRoutes for Settings (wireframes §11 and §13): the trust ladder per kind of decision, and the attention policy. */
export function SettingsScreen() {
  const { t } = useTranslation('foremanNext');
  const attention = useForemanResource((api) => api.attention());
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="sr-only">{t('nav.settings')}</h1>
      <DelegationTable />
      <Panel title={t('attention.title')}>
        <ResourceView resource={attention}>{(policy) => <AttentionForm policy={policy} onSaved={() => void attention.refresh()} />}</ResourceView>
      </Panel>
    </div>
  );
}

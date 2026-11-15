import { useTranslation } from 'react-i18next';

import type { DelegationRule } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';
import { DelegationRow } from '@/modules/foreman-next/settings/DelegationRow';

/** Used by the Settings screen for the trust ladder (BR-5.13): per kind of decision, how much Foreman decides alone, with the agreement rate that earns it more. */
export function DelegationTable({ delegation }: { delegation: Resource<DelegationRule[]> }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('delegation.title')}>
      <ResourceView resource={delegation}>
        {(rules) => (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">{t('delegation.kindHeader')}</th>
                    <th scope="col" className="px-3 py-1 font-medium">{t('delegation.levelHeader')}</th>
                    <th scope="col" className="px-3 py-1 font-medium">{t('delegation.agreedHeader')}</th>
                    <th scope="col" className="py-1 pl-3 font-medium">{t('delegation.suggestsHeader')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <DelegationRow key={rule.kind} rule={rule} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t('delegation.levels')}</p>
            <p className="text-xs text-muted-foreground">{t('delegation.rule')}</p>
          </div>
        )}
      </ResourceView>
    </Panel>
  );
}

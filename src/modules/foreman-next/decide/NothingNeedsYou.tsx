import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/modules/foreman-next/components/EmptyState';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';

/** Used by the Needs you tab when nothing blocks work: it says what Foreman is doing instead (wireframes §15). */
export function NothingNeedsYou() {
  const { t } = useTranslation('foremanNext');
  const today = useForemanResource((api) => api.today());
  const batch = today.data?.running[0]?.batch;
  return <EmptyState title={t('decide.nothing')} body={batch ? t('decide.workingOn', { batch }) : t('decide.idle')} />;
}

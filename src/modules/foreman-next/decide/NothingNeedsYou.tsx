import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/modules/foreman-next/components/EmptyState';

/** Used by the Needs you tab when nothing blocks work: it says what Foreman is doing instead (wireframes §15). */
export function NothingNeedsYou({ batch }: { batch: string | undefined }) {
  const { t } = useTranslation('foremanNext');
  return <EmptyState title={t('decide.nothing')} body={batch ? t('decide.workingOn', { batch }) : t('decide.idle')} />;
}

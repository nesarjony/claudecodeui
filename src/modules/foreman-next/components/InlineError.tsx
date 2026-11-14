import { useTranslation } from 'react-i18next';

/** Used by the cards and forms that change Foreman's state, to say that the last change did not go through. */
export function InlineError() {
  const { t } = useTranslation('foremanNext');
  return (
    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
      {t('common.failed')}
    </p>
  );
}

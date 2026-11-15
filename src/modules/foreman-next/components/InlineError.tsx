import { useTranslation } from 'react-i18next';

/** Used by the cards and forms that change Foreman's state, to say that the last change did not go through, and why when Foreman said. */
export function InlineError({ message = null }: { message?: string | null }) {
  const { t } = useTranslation('foremanNext');
  return (
    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
      {message ?? t('common.failed')}
    </p>
  );
}

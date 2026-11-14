import { useTranslation } from 'react-i18next';

/** Used by ResourceView while a slice of Foreman's state loads for the first time. */
export function LoadingState() {
  const { t } = useTranslation('foremanNext');
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">{t('common.loading')}</span>
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

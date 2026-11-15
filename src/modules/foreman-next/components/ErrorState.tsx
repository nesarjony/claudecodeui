import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';

/** Used by ResourceView when a slice of Foreman's state cannot be loaded and nothing older is on screen. */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('foremanNext');
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm">
      <p>{t('common.loadFailed')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

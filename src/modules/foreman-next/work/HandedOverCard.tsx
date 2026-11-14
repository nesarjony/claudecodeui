import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { RunSummary } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';

/** Used by the board and the list view for a session the owner handed to Foreman (BR-2.10), shown as the run it is. */
export function HandedOverCard({ run }: { run: RunSummary }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Link to={foremanPath.run(run.id)} className="block rounded-md border bg-background p-3 text-sm hover:bg-accent/50">
      <div className="mb-1 flex items-center justify-between gap-2 font-medium">
        {run.batch}
        <Chip tone="info">{t('work.handedOver')}</Chip>
      </div>
      <p className="text-xs text-muted-foreground">{t('work.card.handedOverLine', { turn: run.turn ?? 0, minutes: run.elapsedMinutes })}</p>
    </Link>
  );
}

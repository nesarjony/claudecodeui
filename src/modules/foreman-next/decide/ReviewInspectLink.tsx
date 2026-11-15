import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ReviewItem } from '@/modules/foreman-next/api/contract';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { buttonVariants } from '@/shared/ui';

/** Used by the Review tab and the Today review panel to open what a review item is about: a re-plan's diff, or the decision card of something Foreman decided alone. Rules and lessons have no page yet, so they show their details instead. */
export function ReviewInspectLink({ item }: { item: ReviewItem }) {
  const { t } = useTranslation('foremanNext');
  const { kind, subject } = item;
  if (kind === 'replan' && subject.kind === 'goal') {
    return (
      <Link to={foremanPath.goalCompare(subject.id)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        {t('review.diff')}
      </Link>
    );
  }
  if (kind === 'delegated-decision' && subject.kind === 'decision') {
    return (
      <Link to={foremanPath.decision(subject.id)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        {t('review.card')}
      </Link>
    );
  }
  return null;
}

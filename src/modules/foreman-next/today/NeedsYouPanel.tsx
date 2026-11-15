import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { OwnerQuestion } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useAgo } from '@/modules/foreman-next/hooks/useAgo';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { buttonVariants } from '@/shared/ui';

function QuestionLine({ question }: { question: OwnerQuestion }) {
  const { t } = useTranslation('foremanNext');
  const ago = useAgo(question.askedAt);
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          <span aria-hidden className="mr-1.5 text-amber-600">
            ●
          </span>
          {question.title}
        </p>
        <p className="text-xs text-muted-foreground">{t('today.holds', { count: question.holdsRows, ago })}</p>
      </div>
      <Link to={foremanPath.needsYou(question.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t('today.decide')}
      </Link>
    </li>
  );
}

/** Used by the Today screen to list the decisions that block work, in the order Foreman gives them (most rows held first). */
export function NeedsYouPanel({ questions }: { questions: Resource<OwnerQuestion[]> }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('today.needsYou')}>
      <ResourceView resource={questions} isEmpty={(items) => items.length === 0} empty={<p className="text-sm text-muted-foreground">{t('today.needsYouNone')}</p>}>
        {(items) => (
          <ul className="space-y-3">
            {items.map((question) => (
              <QuestionLine key={question.id} question={question} />
            ))}
          </ul>
        )}
      </ResourceView>
    </Panel>
  );
}

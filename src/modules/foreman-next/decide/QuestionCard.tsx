import { Link } from 'react-router-dom';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { OwnerQuestion } from '@/modules/foreman-next/api/contract';
import { QuestionAnswerForm } from '@/modules/foreman-next/decide/QuestionAnswerForm';
import { QuestionOptionsTable } from '@/modules/foreman-next/decide/QuestionOptionsTable';
import { QuestionRecommendation } from '@/modules/foreman-next/decide/QuestionRecommendation';
import { useAgo } from '@/modules/foreman-next/hooks/useAgo';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Card } from '@/shared/ui';

/** Used by the Needs you tab for one decision built for a single tap (wireframes §5a): context, options with impact, Foreman's recommendation, what happens unanswered. */
export function QuestionCard({ question }: { question: OwnerQuestion }) {
  const { t } = useTranslation('foremanNext');
  const headingId = useId();
  const ago = useAgo(question.askedAt);
  const { delegationKind } = question;
  const kindLabel = delegationKind ? t(`delegation.kind.${delegationKind}`) : null;
  const asks = delegationKind ? t(`delegation.asks.${delegationKind}`) : null;
  return (
    <Card role="article" aria-labelledby={headingId} className="space-y-4 p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 id={headingId} className="text-base font-semibold">
            {question.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {kindLabel ? `${kindLabel} · ` : ''}{t('decide.holdsAsked', { count: question.holdsRows, ago })}
          </p>
        </div>
        {asks ? (
          <p className="text-sm text-muted-foreground">
            {t('decide.whyYours', { asks, level: t(`delegation.level.${question.delegationLevel}`) })}{' '}
            <Link to={foremanPath.settings} className="text-primary hover:underline">
              {t('decide.changeRule')}
            </Link>
          </p>
        ) : null}
      </header>
      <section className="space-y-1">
        <h3 className="text-sm font-medium">{t('decide.context')}</h3>
        <p className="text-sm text-muted-foreground">{question.context}</p>
      </section>
      <QuestionOptionsTable options={question.options} recommendedId={question.recommendation?.optionId ?? null} />
      {question.recommendation ? <QuestionRecommendation recommendation={question.recommendation} /> : null}
      <p className="text-sm">
        <span className="font-medium">{t('decide.ifUnanswered')}</span> {question.ifUnanswered}
      </p>
      <QuestionAnswerForm question={question} asks={asks} />
    </Card>
  );
}

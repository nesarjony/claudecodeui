import { useTranslation } from 'react-i18next';

import type { QuestionRecommendation as Recommendation, SimilarDecision } from '@/modules/foreman-next/api/contract';
import { useAgo } from '@/modules/foreman-next/hooks/useAgo';

function SimilarLine({ decision }: { decision: SimilarDecision }) {
  const { t } = useTranslation('foremanNext');
  const ago = useAgo(decision.decidedAt);
  return (
    <li>
      {decision.title} · {decision.choice} · {t('decide.ago', { ago })}
    </li>
  );
}

/** Used by the question card for Foreman's recommendation, its confidence, the reason, and the owner's own similar past decisions behind it (BR-5.2). */
export function QuestionRecommendation({ recommendation }: { recommendation: Recommendation }) {
  const { t } = useTranslation('foremanNext');
  return (
    <section aria-label={t('decide.recommendation')} className="space-y-1 text-sm">
      <p className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{t('decide.recommends', { option: recommendation.optionId })}</span>
        <span className="text-xs text-muted-foreground">{t('decide.confidence', { value: recommendation.confidence.toFixed(1) })}</span>
      </p>
      <p className="text-muted-foreground">{recommendation.reason}</p>
      {recommendation.similar.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">↗ {t('decide.similar', { count: recommendation.similar.length })}</summary>
          <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
            {recommendation.similar.map((decision) => (
              <SimilarLine key={decision.id} decision={decision} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

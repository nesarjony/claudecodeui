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

// Foreman sends `confidence: null` when nobody stated one (every gate and approval question, and the worker-stalled one), so the contract's `number` is wider here.
// `reason` and `similar` are read just as defensively, so a thin recommendation shows less and never breaks the card.
type TolerantRecommendation = Omit<Recommendation, 'confidence'> & { confidence?: number | null };

/** The confidence as shown ("0.7"), or null when there is none to show: null, missing or not a finite number. */
export function shownConfidence(confidence: unknown): string | null {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence.toFixed(1) : null;
}

/** Used by the question card for Foreman's recommendation, its confidence (only when one was stated), the reason, and the owner's own similar past decisions behind it (BR-5.2). */
export function QuestionRecommendation({ recommendation }: { recommendation: TolerantRecommendation }) {
  const { t } = useTranslation('foremanNext');
  const confidence = shownConfidence(recommendation.confidence);
  const similar = Array.isArray(recommendation.similar) ? recommendation.similar : [];
  return (
    <section aria-label={t('decide.recommendation')} className="space-y-1 text-sm">
      <p className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{t('decide.recommends', { option: recommendation.optionId })}</span>
        {confidence === null ? null : <span className="text-xs text-muted-foreground">{t('decide.confidence', { value: confidence })}</span>}
      </p>
      {recommendation.reason ? <p className="text-muted-foreground">{recommendation.reason}</p> : null}
      {similar.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">↗ {t('decide.similar', { count: similar.length })}</summary>
          <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
            {similar.map((decision) => (
              <SimilarLine key={decision.id} decision={decision} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

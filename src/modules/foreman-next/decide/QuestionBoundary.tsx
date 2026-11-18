import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { Card } from '@/shared/ui';

function UnavailableQuestion({ id }: { id: string }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Card role="alert" className="space-y-1 p-4 text-sm">
      <p className="font-medium">{t('decide.questionUnavailable')}</p>
      <p className="text-xs text-muted-foreground">{t('decide.questionUnavailableId', { id })}</p>
    </Card>
  );
}

/** Used by the Needs you tab around each question: one malformed question shows "could not be displayed" with its id, and the rest of the list stays usable. It tries the question again when new data replaces it. */
export function QuestionBoundary({ question, children }: { question: unknown; children: ReactNode }) {
  const id = (question as { id?: unknown } | null | undefined)?.id;
  return (
    <ErrorBoundary resetKeys={[question]} fallback={<UnavailableQuestion id={typeof id === 'string' ? id : '?'} />}>
      {children}
    </ErrorBoundary>
  );
}

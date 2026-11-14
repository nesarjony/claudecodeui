import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent } from 'react';

import type { DecisionRecord } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Input } from '@/shared/ui';

type DecisionFeedbackFormProps = { record: DecisionRecord; onSaved: () => void };

/** Used by the decision card for the owner's view: Good, or Bad with what Foreman should have done, which becomes a test case (BR-7.11). */
export function DecisionFeedbackForm({ record, onSaved }: DecisionFeedbackFormProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // Whether the "Bad" correction field is open; Good saves at once, Bad waits for the correction.
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const { feedback } = record;

  const save = async (task: () => Promise<unknown>) => {
    if (await run(task)) {
      setCorrecting(false);
      onSaved();
    }
  };

  const saveBad = (event: FormEvent) => {
    event.preventDefault();
    void save(() => api.rateDecision(record.id, { verdict: 'bad', correction: correction.trim() || null }));
  };

  return (
    <section aria-label={t('record.yourView')} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-2 text-sm font-medium">{t('record.yourView')}</h3>
        <Button variant={feedback?.verdict === 'good' ? 'default' : 'outline'} size="sm" aria-pressed={feedback?.verdict === 'good'} disabled={busy} onClick={() => void save(() => api.rateDecision(record.id, { verdict: 'good' }))}>
          {t('record.good')}
        </Button>
        <Button variant={feedback?.verdict === 'bad' ? 'default' : 'outline'} size="sm" aria-pressed={feedback?.verdict === 'bad' || correcting} disabled={busy} onClick={() => setCorrecting(true)}>
          {t('record.bad')}
        </Button>
      </div>
      {correcting ? (
        <form onSubmit={saveBad} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`correction-${record.id}`} className="text-sm text-muted-foreground">
            {t('record.shouldHave')}
          </label>
          <Input id={`correction-${record.id}`} value={correction} onChange={(event) => setCorrection(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" disabled={busy}>
            {t('common.save')}
          </Button>
        </form>
      ) : null}
      {feedback?.verdict === 'bad' && feedback.correction ? <p className="text-sm text-muted-foreground">{t('record.savedCorrection', { correction: feedback.correction })}</p> : null}
      <p className="text-xs text-muted-foreground">{t('record.testCaseNote')}</p>
      {failed ? <InlineError /> : null}
    </section>
  );
}

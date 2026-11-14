import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent, KeyboardEvent } from 'react';

import type { OwnerQuestion, RememberScope } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Input } from '@/shared/ui';

const SCOPES: RememberScope[] = ['repo', 'goal', 'global'];

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const step = ARROW_STEP[event.key];
  if (!step) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
  const current = buttons.findIndex((button) => button === document.activeElement);
  buttons[(current + step + buttons.length) % buttons.length]?.focus();
  event.preventDefault();
}

type QuestionAnswerFormProps = { question: OwnerQuestion; asks: string; onAnswered: () => void };

/** Used by the question card for the one-tap answer buttons, a free-text reply, and the two things an answer can teach Foreman: a rule, and a step up the trust ladder. */
export function QuestionAnswerForm({ question, asks, onAnswered }: QuestionAnswerFormProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // The typed reply, an alternative to tapping an option.
  const [reply, setReply] = useState('');
  // Whether the answer is also saved as a rule, and for which scope; checked by default because the wireframes' card is.
  const [remember, setRemember] = useState(true);
  const [scope, setScope] = useState<RememberScope>('repo');
  // Whether this kind of decision moves up the trust ladder with this answer.
  const [delegate, setDelegate] = useState(false);

  const answer = async (optionId: string | null, text: string | null) => {
    const saved = await run(() => api.answerQuestion(question.id, { optionId, reply: text, remember: remember ? scope : null, delegate }));
    if (saved) onAnswered();
  };

  const sendReply = (event: FormEvent) => {
    event.preventDefault();
    if (reply.trim()) void answer(null, reply.trim());
  };

  return (
    <div className="space-y-3 border-t pt-3">
      <form onSubmit={sendReply} className="flex flex-wrap items-center gap-2">
        <div role="toolbar" aria-label={t('decide.answer')} onKeyDown={moveFocus} className="flex gap-2">
          {question.options.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant={question.recommendation?.optionId === option.id ? 'default' : 'outline'}
              size="sm"
              disabled={busy}
              aria-label={`${option.id}: ${option.label}`}
              onClick={() => void answer(option.id, null)}
            >
              {option.id}
            </Button>
          ))}
        </div>
        <label htmlFor={`reply-${question.id}`} className="text-sm text-muted-foreground">
          {t('decide.orReply')}
        </label>
        <Input id={`reply-${question.id}`} value={reply} onChange={(event) => setReply(event.target.value)} className="min-w-0 flex-1" />
        <Button type="submit" size="sm" disabled={busy || reply.trim() === ''}>
          {t('decide.send')}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          {t('decide.remember')}
        </label>
        <fieldset disabled={!remember} className="flex flex-wrap items-center gap-x-3 text-muted-foreground">
          <legend className="sr-only">{t('decide.scope')}</legend>
          <span aria-hidden>{t('decide.scope')}</span>
          {SCOPES.map((option) => (
            <label key={option} className="flex items-center gap-1.5">
              <input type="radio" name={`scope-${question.id}`} checked={scope === option} onChange={() => setScope(option)} />
              {option === 'repo' ? question.repo : t(`decide.scopes.${option}`)}
            </label>
          ))}
        </fieldset>
      </div>
      <label className="flex items-start gap-1.5 text-sm">
        <input type="checkbox" className="mt-1" checked={delegate} onChange={(event) => setDelegate(event.target.checked)} />
        {t('decide.delegate', { asks })}
      </label>
      {failed ? <InlineError /> : null}
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent, Ref } from 'react';

import type { ChatDelivery } from '@/modules/foreman-next/api/contract';
import { Button, Input } from '@/shared/ui';

type ChatComposerProps = { busy: boolean; inputRef: Ref<HTMLInputElement>; onSend: (text: string, delivery: ChatDelivery) => Promise<boolean> };

const DELIVERIES: ChatDelivery[] = ['next-safe-point', 'after-batch'];

/** Used by the chat drawer for the message field and the choice of when the message reaches Foreman mid-run. */
export function ChatComposer({ busy, inputRef, onSend }: ChatComposerProps) {
  const { t } = useTranslation('foremanNext');
  // The unsent message; kept when sending fails so the owner does not retype it.
  const [text, setText] = useState('');
  // When the message reaches Foreman: "next safe point" interrupts nothing, "after batch" waits for the batch to end.
  const [delivery, setDelivery] = useState<ChatDelivery>('next-safe-point');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (message && (await onSend(message, delivery))) setText('');
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2 border-t p-3">
      <div className="flex gap-2">
        <Input ref={inputRef} value={text} onChange={(event) => setText(event.target.value)} placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')} />
        <Button type="submit" size="sm" className="h-9" disabled={busy || text.trim() === ''}>
          {t('chat.send')}
        </Button>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <legend className="sr-only">{t('chat.deliver')}</legend>
        <span aria-hidden>{t('chat.deliver')}</span>
        {DELIVERIES.map((option) => (
          <label key={option} className="flex items-center gap-1.5">
            <input type="radio" name="chat-delivery" value={option} checked={delivery === option} onChange={() => setDelivery(option)} />
            {t(`chat.delivery.${option}`)}
          </label>
        ))}
      </fieldset>
    </form>
  );
}

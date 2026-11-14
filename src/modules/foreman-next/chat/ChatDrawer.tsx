import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent, RefObject } from 'react';

import type { ChatDelivery, ChatSubjectRef } from '@/modules/foreman-next/api/contract';
import { ChatComposer } from '@/modules/foreman-next/chat/ChatComposer';
import { ChatMessageItem } from '@/modules/foreman-next/chat/ChatMessageItem';
import { subjectFromPath, subjectFromValue, subjectValue } from '@/modules/foreman-next/chat/chatSubject';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { Button } from '@/shared/ui';

type ChatDrawerProps = { returnFocusTo: RefObject<HTMLElement>; onClose: () => void };

/** Used by ForemanShell for the chat drawer (⌘J): a conversation about whatever is on screen, with every action it took listed. */
export function ChatDrawer({ returnFocusTo, onClose }: ChatDrawerProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { pathname } = useLocation();
  const { busy, failed, run } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLLIElement>(null);
  // A subject the owner picked from the list; it applies only to the screen it was picked on, so moving on resets to that screen's subject.
  const [picked, setPicked] = useState<{ path: string; subject: ChatSubjectRef } | null>(null);
  const subject = picked?.path === pathname ? picked.subject : subjectFromPath(pathname);
  const thread = useForemanResource((foreman) => foreman.chatThread(subject), { key: subjectValue(subject) });

  useEffect(() => {
    inputRef.current?.focus();
    const target = returnFocusTo.current;
    return () => target?.focus();
  }, [returnFocusTo]);

  const messageCount = thread.data?.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messageCount]);

  const send = async (text: string, delivery: ChatDelivery) => {
    const sent = await run(() => api.sendChat({ subject, text, delivery }));
    if (sent) await thread.refresh();
    return sent;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };

  return (
    <aside
      id="foreman-chat-drawer"
      aria-label={t('chat.label')}
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-card shadow-xl lg:static lg:z-auto lg:w-96 lg:max-w-none lg:shadow-none"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <label htmlFor="foreman-chat-subject" className="text-muted-foreground">
          {t('chat.about')}
        </label>
        <select
          id="foreman-chat-subject"
          value={subjectValue(subject)}
          onChange={(event) => setPicked({ path: pathname, subject: subjectFromValue(event.target.value, thread.data?.subjects ?? []) })}
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
        >
          {(thread.data?.subjects ?? []).map((option) => (
            <option key={subjectValue(option)} value={subjectValue(option)}>
              {option.label}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('chat.close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ResourceView resource={thread} isEmpty={(data) => data.messages.length === 0} empty={<p className="text-sm text-muted-foreground">{t('chat.empty')}</p>}>
          {(data) => (
            <ul role="log" aria-label={t('chat.conversation')} aria-live="polite" className="space-y-4">
              {data.messages.map((message) => (
                <ChatMessageItem key={message.id} message={message} onChanged={() => void thread.refresh()} />
              ))}
              <li ref={endRef} aria-hidden />
            </ul>
          )}
        </ResourceView>
        {failed ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{t('chat.sendFailed')}</p> : null}
      </div>
      <ChatComposer busy={busy} inputRef={inputRef} onSend={send} />
    </aside>
  );
}

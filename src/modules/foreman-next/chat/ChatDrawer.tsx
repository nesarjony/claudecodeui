import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent, RefObject } from 'react';

import type { ChatDelivery } from '@/modules/foreman-next/api/contract';
import { ChatComposer } from '@/modules/foreman-next/chat/ChatComposer';
import { ChatMessageItem } from '@/modules/foreman-next/chat/ChatMessageItem';
import { chatContextOf, subjectFromPath } from '@/modules/foreman-next/chat/chatSubject';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { NativeSelect } from '@/modules/foreman-next/components/NativeSelect';
import { ResourceView } from '@/modules/foreman-next/components/ResourceView';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useFocusTrap } from '@/modules/foreman-next/hooks/useFocusTrap';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { Button } from '@/shared/ui';

const NARROW_BELOW_PX = 1024;

type ChatDrawerProps = { returnFocusTo: RefObject<HTMLElement>; onClose: () => void };

/** Used by ForemanShell for the chat drawer (⌘J): the conversation of a goal, about whatever is on screen, with every action it took listed. */
export function ChatDrawer({ returnFocusTo, onClose }: ChatDrawerProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { pathname } = useLocation();
  const { busy, failed, run } = useAction();
  const { isMobile: narrow } = useDeviceSettings({ mobileBreakpoint: NARROW_BELOW_PX, trackPWA: false });
  const drawerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLLIElement>(null);
  // The goal the owner picked from the list; it applies only to the screen it was picked on, so moving on goes back to the goal of that screen.
  const [picked, setPicked] = useState<{ path: string; goalId: string | null } | null>(null);
  const subject = subjectFromPath(pathname);
  const pickedGoal = picked?.path === pathname ? picked : null;
  const view = useForemanResource(
    async (foreman) => {
      const context = await chatContextOf(foreman, subject);
      const goalId = pickedGoal ? pickedGoal.goalId : context.goalId;
      return { context, goalId, thread: await foreman.chatThread(goalId) };
    },
    { key: `${subject.kind}:${subject.id}:${pickedGoal ? (pickedGoal.goalId ?? '') : '-'}` },
  );
  useFocusTrap(drawerRef, narrow);

  useEffect(() => {
    inputRef.current?.focus();
    const target = returnFocusTo.current;
    return () => target?.focus();
  }, [returnFocusTo]);

  const messageCount = view.data?.thread.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messageCount]);

  const send = async (text: string, delivery: ChatDelivery) => {
    const goalId = view.data?.goalId ?? null;
    return (await run(() => api.sendChat({ goalId, subject, text, delivery }))).ok;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };

  return (
    <aside
      ref={drawerRef}
      id="foreman-chat-drawer"
      aria-label={t('chat.label')}
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-card shadow-xl lg:static lg:z-auto lg:w-96 lg:max-w-none lg:shadow-none"
    >
      <header className="space-y-1 border-b px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor="foreman-chat-goal" className="text-muted-foreground">
            {t('chat.about')}
          </label>
          <NativeSelect
            id="foreman-chat-goal"
            value={view.data?.goalId ?? ''}
            onChange={(event) => setPicked({ path: pathname, goalId: event.target.value || null })}
            className="min-w-0 flex-1 py-1"
          >
            <option value="">{t('chat.general')}</option>
            {(view.data?.thread.goals ?? []).map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.label}
              </option>
            ))}
          </NativeSelect>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('chat.close')} onClick={onClose}>
            <X />
          </Button>
        </div>
        {view.data?.context.label ? <p className="text-xs text-muted-foreground">{t('chat.looking', { label: view.data.context.label })}</p> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ResourceView resource={view} isEmpty={(data) => data.thread.messages.length === 0} empty={<p className="text-sm text-muted-foreground">{t('chat.empty')}</p>}>
          {(data) => (
            <ul role="log" aria-label={t('chat.conversation')} aria-live="polite" className="space-y-4">
              {data.thread.messages.map((message) => (
                <ChatMessageItem key={message.id} message={message} />
              ))}
              <li ref={endRef} aria-hidden />
            </ul>
          )}
        </ResourceView>
        {failed ? <InlineError /> : null}
      </div>
      <ChatComposer busy={busy} inputRef={inputRef} onSend={send} />
    </aside>
  );
}

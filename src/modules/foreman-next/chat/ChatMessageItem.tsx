import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/modules/foreman-next/api/contract';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';
import { chatLinkPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

type ChatMessageItemProps = { message: ChatMessage; onChanged: () => void };

/** Used by the chat drawer for one message: who said it, when, the evidence it links to and the actions Foreman took, with Undo. */
export function ChatMessageItem({ message, onChanged }: ChatMessageItemProps) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const { actions } = message;

  const undo = async () => {
    if (actions && (await run(() => api.undoChatActions(actions.id)))) onChanged();
  };

  return (
    <li className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t(`chat.role.${message.role}`)}</span> · {formatClock(message.at)}
      </p>
      <p className="whitespace-pre-wrap text-sm">{message.text}</p>
      {message.evidence.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 text-xs">
          {message.evidence.map((link) => (
            <Link key={`${link.kind}-${link.id}-${link.label}`} to={chatLinkPath(link)} className="text-primary hover:underline">
              ↗ {link.label}
            </Link>
          ))}
        </p>
      ) : null}
      {actions ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{actions.undone ? t('chat.undone') : t('chat.actions', { count: actions.count })}</span>
          {actions.undone ? null : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void undo()}>
              {t('chat.undo')}
            </Button>
          )}
        </div>
      ) : null}
      {failed ? <InlineError /> : null}
    </li>
  );
}

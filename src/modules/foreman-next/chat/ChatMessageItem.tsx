import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { formatClock } from '@/modules/foreman-next/utils/foremanFormat';
import { entityPath } from '@/modules/foreman-next/utils/foremanPaths';
import { Button } from '@/shared/ui';

// The contract types a proposal as open, confirmed or expired (confirming an expired one returns a 409), and Foreman may add states later.
// So only a proposal known to be open gets the Confirm button; every other state is shown as text and never actionable.
const isOpenProposal = (state: unknown): boolean => state === 'open';

function ProposalState({ state }: { state: unknown }) {
  const { t } = useTranslation('foremanNext');
  if (state === 'confirmed') return <span className="text-muted-foreground">{t('chat.confirmed')}</span>;
  if (state === 'expired') return <span className="text-muted-foreground">{t('chat.expired')}</span>;
  return <span className="text-muted-foreground">{typeof state === 'string' ? state : ''}</span>;
}

/** Used by the chat drawer for one message: who said it, when, the evidence it links to, the actions Foreman took (with Undo), what it proposes and cannot do itself (with Confirm, the owner's own press), and Remember to keep an answer as knowledge (BR-5.1). */
export function ChatMessageItem({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const { actions, proposals } = message;

  return (
    <li className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t(`chat.role.${message.role}`)}</span> · {formatClock(message.at)}
      </p>
      <p className="whitespace-pre-wrap text-sm">{message.text}</p>
      {message.evidence.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 text-xs">
          {message.evidence.map((link) => {
            const to = entityPath(link);
            const key = `${link.kind}-${link.id}-${link.label}`;
            return to === null ? (
              <span key={key} className="text-muted-foreground">
                {link.label}
              </span>
            ) : (
              <Link key={key} to={to} className="text-primary hover:underline">
                ↗ {link.label}
              </Link>
            );
          })}
        </p>
      ) : null}
      {actions ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{actions.undone ? t('chat.undone') : t('chat.actions', { count: actions.count })}</span>
          {actions.undone ? null : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.undoChatActions(actions.id))}>
              {t('chat.undo')}
            </Button>
          )}
        </div>
      ) : null}
      {proposals.map((proposal) => (
        <div key={proposal.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
          <span>{proposal.summary}</span>
          {isOpenProposal(proposal.state) ? (
            <Button variant="default" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.confirmChatProposal(proposal.id))}>
              {t('chat.confirm')}
            </Button>
          ) : (
            <ProposalState state={proposal.state} />
          )}
        </div>
      ))}
      {message.role === 'foreman' ? (
        message.remembered ? (
          <p className="text-xs text-muted-foreground">{t('chat.remembered')}</p>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api.rememberChatMessage(message.id))}>
            {t('chat.remember')}
          </Button>
        )
      ) : null}
      {failed ? <InlineError /> : null}
    </li>
  );
}

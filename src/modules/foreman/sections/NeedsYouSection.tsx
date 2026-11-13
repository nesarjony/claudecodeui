import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Target } from 'lucide-react';

import { Button } from '@/shared/ui';
import { errorMessage, foremanTabApi } from '@/modules/foreman/api';
import { Chip } from '@/modules/foreman/components/Chip';
import { Ago, Empty, LoadError, Loading, SessionLink } from '@/modules/foreman/components/Bits';
import ConfirmDialog from '@/modules/foreman/components/ConfirmDialog';
import type { PolledResource } from '@/modules/foreman/usePolledResource';
import type { InboxAnswer, InboxItem } from '@/modules/foreman/types';

type NeedsYouSectionProps = {
  inbox: PolledResource<InboxItem[]>;
  onOpenSession: (sessionId: string) => void;
  /** Called after an answer so the counts in the status bar refresh too. */
  onAnswered: () => void;
  /** Opens a goal's detail in the Goals section (a goal's items: plan approval, budget, question). */
  onOpenGoal?: (goalId: string) => void;
};

const LINK =
  'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted';

/**
 * One thing Foreman is waiting on: a question with an answer box, a permission with Allow and Deny, or a goal's plan
 * with Approve and Reject (its full review is in the Goals section).
 */
function InboxCard({
  item,
  onOpenSession,
  onAnswered,
  onOpenGoal,
  refresh,
}: {
  item: InboxItem;
  onOpenSession: (id: string) => void;
  onAnswered: () => void;
  onOpenGoal?: (goalId: string) => void;
  refresh: () => Promise<void>;
}) {
  const { t } = useTranslation('foreman');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const isPlan = item.kind === 'plan';
  const isDecision = item.kind === 'permission' || item.kind === 'budget';
  const goalId = item.goalId ?? null;
  const openGoal = goalId && onOpenGoal ? () => onOpenGoal(goalId) : null;

  const send = async (answer: InboxAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await foremanTabApi.answer(item.id, answer);
      setText('');
      setReason('');
      await refresh();
      onAnswered();
    } catch (failure) {
      setError(errorMessage(failure, t('common.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-testid="foreman-inbox-item" data-kind={item.kind} className="min-w-0 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="warn">{t(`needs.kind.${item.kind}`, { defaultValue: item.kind })}</Chip>
        <Ago iso={item.createdAt} />
      </div>
      {item.title && <p className="break-words text-sm font-medium text-foreground">{item.title}</p>}
      {item.question && <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{item.question}</p>}

      {isPlan && (
        <div className="space-y-2">
          {openGoal && (
            <Button variant="outline" className="h-10 w-full" onClick={openGoal}>
              {t('needs.reviewPlan')}
            </Button>
          )}
          {/* A plan is answered with allow: the option words alone would ask for a revision. */}
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-11" disabled={busy} onClick={() => void send({ allow: true })}>
              {t('needs.approve')}
            </Button>
            <Button variant="outline" className="h-11" disabled={busy} onClick={() => setRejecting(true)}>
              {t('needs.reject')}
            </Button>
          </div>
        </div>
      )}

      {!isPlan && item.options && item.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((option) => (
            <Button key={option} size="sm" variant="outline" className="h-10 max-w-full whitespace-normal text-left" disabled={busy} onClick={() => void send({ text: option })}>
              {option}
            </Button>
          ))}
        </div>
      )}

      {isPlan ? null : isDecision ? (
        <div className="space-y-2">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            aria-label={t('needs.reasonLabel')}
            placeholder={t('needs.reasonPlaceholder')}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-11" disabled={busy} onClick={() => void send({ allow: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>
              {t('needs.allow')}
            </Button>
            <Button variant="outline" className="h-11" disabled={busy} onClick={() => void send({ allow: false, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>
              {t('needs.deny')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            maxLength={20000}
            aria-label={t('needs.answerLabel')}
            placeholder={t('needs.answerPlaceholder')}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button className="h-11 w-full" disabled={busy || !text.trim()} onClick={() => void send({ text: text.trim() })}>
            {t('needs.send')}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="break-words text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {(item.sessionId || (openGoal && !isPlan)) && (
        <div className="flex flex-wrap items-center gap-2">
          {openGoal && !isPlan && (
            <button type="button" onClick={openGoal} className={LINK}>
              <Target className="h-3.5 w-3.5" aria-hidden />
              {t('needs.openGoal')}
            </button>
          )}
          {item.sessionId && <SessionLink sessionId={item.sessionId} onOpen={onOpenSession} />}
        </div>
      )}

      {rejecting && (
        <ConfirmDialog
          open
          title={t('goals.approval.rejectTitle')}
          description={t('goals.approval.rejectBody')}
          confirmLabel={t('goals.approval.rejectConfirm')}
          cancelLabel={t('goals.keep')}
          tone="danger"
          onConfirm={async () => {
            await foremanTabApi.answer(item.id, { allow: false });
            setRejecting(false);
            await refresh();
            onAnswered();
          }}
          onCancel={() => setRejecting(false)}
        />
      )}
    </li>
  );
}

/** Everything waiting on the user. Answers go to Foreman; the list and the status bar count refresh straight away. */
export default function NeedsYouSection({ inbox, onOpenSession, onAnswered, onOpenGoal }: NeedsYouSectionProps) {
  const { t } = useTranslation('foreman');
  return (
    <>
      {inbox.error && <LoadError error={inbox.error} onRetry={() => void inbox.refresh()} />}
      {!inbox.data && !inbox.error && <Loading />}
      {inbox.data && inbox.data.length === 0 && <Empty>{t('needs.empty')}</Empty>}
      {inbox.data && inbox.data.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-2 p-0">
          {inbox.data.map((item) => (
            <InboxCard key={item.id} item={item} onOpenSession={onOpenSession} onAnswered={onAnswered} onOpenGoal={onOpenGoal} refresh={inbox.refresh} />
          ))}
        </ul>
      )}
    </>
  );
}

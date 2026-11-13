import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { errorMessage, foremanTabApi } from '@/modules/foreman/api';
import ConfirmDialog from '@/modules/foreman/components/ConfirmDialog';
import { formatUsd } from '@/modules/foreman/format';
import { goalsApi } from '@/modules/foreman/goals/api';
import { goalActions } from '@/modules/foreman/goals/goalView';
import type { ApprovePlanInput, GoalDetail } from '@/modules/foreman/goals/types';
import type { InboxAnswer } from '@/modules/foreman/types';

const TEXTAREA =
  'w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-red-500 sm:text-sm';
const WAITING = 'min-w-0 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5';

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="m-0 break-words text-xs text-red-700 dark:text-red-400">
      {message}
    </p>
  );
}

type Done = () => Promise<void>;

/**
 * The plan waits for the user: approve it, approve it with a note for the workers, ask for changes (the planner plans
 * again with the note) or reject it (the goal is cancelled, after a confirm). Calls `POST /goals/:id/approve-plan`.
 */
export function PlanApproval({ goal, onDone }: { goal: GoalDetail; onDone: Done }) {
  const { t } = useTranslation('foreman');
  const [mode, setMode] = useState<'note' | 'revise' | null>(null);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const trimmed = note.trim();
  const missing = tried && !trimmed;

  const send = async (input: ApprovePlanInput) => {
    setBusy(true);
    setError(null);
    try {
      await goalsApi.approvePlan(goal.id, input);
      setNote('');
      setMode(null);
      setTried(false);
      await onDone();
    } catch (failure) {
      setError(errorMessage(failure, t('common.failed')));
    } finally {
      setBusy(false);
    }
  };

  const sendNote = () => {
    if (!trimmed) {
      setTried(true);
      return;
    }
    void send(mode === 'revise' ? { decision: 'revise', note: trimmed } : { decision: 'approve', note: trimmed });
  };

  const question = goal.pending?.kind === 'plan' ? goal.pending.question.trim() : '';

  return (
    <div data-testid="foreman-goal-approval" className={WAITING}>
      <p className="m-0 text-sm font-semibold text-foreground">{t('goals.approval.title')}</p>
      <p className="m-0 whitespace-pre-wrap break-words text-xs text-foreground/90">{question || t('goals.approval.body')}</p>
      {goal.plan && (
        <p className="m-0 text-xs text-muted-foreground">
          {t('goals.approval.planLine', { revision: goal.plan.revision, cost: formatUsd(goal.plan.estimatedCostUsd), count: goal.tasks.length })}
        </p>
      )}

      {mode === null ? (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-11 whitespace-normal" disabled={busy} onClick={() => void send({ decision: 'approve' })}>
            {t('goals.approval.approve')}
          </Button>
          <Button variant="outline" className="h-11 whitespace-normal leading-tight" disabled={busy} onClick={() => setMode('note')}>
            {t('goals.approval.approveWithNote')}
          </Button>
          <Button variant="outline" className="h-11 whitespace-normal leading-tight" disabled={busy} onClick={() => setMode('revise')}>
            {t('goals.approval.revise')}
          </Button>
          <Button variant="outline" className="h-11 whitespace-normal text-red-700 dark:text-red-400" disabled={busy} onClick={() => setRejecting(true)}>
            {t('goals.approval.reject')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="foreman-goal-plan-note" className="block text-xs font-medium text-foreground/80">
            {mode === 'revise' ? t('goals.approval.reviseLabel') : t('goals.approval.noteLabel')}
          </label>
          <textarea
            id="foreman-goal-plan-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={5000}
            placeholder={mode === 'revise' ? t('goals.approval.revisePlaceholder') : t('goals.approval.notePlaceholder')}
            aria-invalid={missing ? true : undefined}
            aria-describedby={missing ? 'foreman-goal-plan-note-error' : undefined}
            className={TEXTAREA}
          />
          {missing && (
            <p id="foreman-goal-plan-note-error" className="m-0 text-[11px] font-medium text-red-700 dark:text-red-400">
              {mode === 'revise' ? t('goals.approval.reviseRequired') : t('goals.approval.noteRequired')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-11 whitespace-normal leading-tight" disabled={busy} onClick={sendNote}>
              {busy ? t('common.working') : mode === 'revise' ? t('goals.approval.sendRevise') : t('goals.approval.sendNote')}
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => {
                setMode(null);
                setTried(false);
              }}
            >
              {t('goals.approval.back')}
            </Button>
          </div>
        </div>
      )}

      <ErrorLine message={error} />

      {rejecting && (
        <ConfirmDialog
          open
          title={t('goals.approval.rejectTitle')}
          description={t('goals.approval.rejectBody')}
          confirmLabel={t('goals.approval.rejectConfirm')}
          cancelLabel={t('goals.keep')}
          tone="danger"
          onConfirm={async () => {
            await goalsApi.approvePlan(goal.id, { decision: 'reject' });
            setRejecting(false);
            await onDone();
          }}
          onCancel={() => setRejecting(false)}
        />
      )}
    </div>
  );
}

/**
 * The goal waits on a budget or a question. A budget: extend it by the goal's budget once more, or fail the goal. A
 * question (a part failed after its re-plan, or the judge ran out of runs): guidance for one more attempt, or fail the
 * goal. Answers go to the inbox route, like every needs-you item.
 */
export function PendingAnswer({ goal, onDone }: { goal: GoalDetail; onDone: Done }) {
  const { t } = useTranslation('foreman');
  const pending = goal.pending;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failing, setFailing] = useState(false);
  if (!pending || pending.kind === 'plan') return null;
  const isBudget = pending.kind === 'budget';
  const failAnswer: InboxAnswer = isBudget ? { allow: false } : { text: 'fail' };

  const send = async (answer: InboxAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await foremanTabApi.answer(pending.inboxId, answer);
      setText('');
      await onDone();
    } catch (failure) {
      setError(errorMessage(failure, t('common.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="foreman-goal-pending" data-kind={pending.kind} className={WAITING}>
      <p className="m-0 text-sm font-semibold text-foreground">{t(isBudget ? 'goals.pending.budgetTitle' : 'goals.pending.questionTitle')}</p>
      {pending.question && <p className="m-0 whitespace-pre-wrap break-words text-sm text-foreground/90">{pending.question}</p>}
      {isBudget && (
        <p className="m-0 text-xs tabular-nums text-muted-foreground">{t('goals.spendOfBudget', { spent: formatUsd(goal.spend.totalUsd), budget: formatUsd(goal.spend.budgetUsd) })}</p>
      )}
      {isBudget ? (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-11 whitespace-normal leading-tight" disabled={busy} onClick={() => void send({ allow: true })}>
            {t('goals.pending.extend')}
          </Button>
          <Button variant="outline" className="h-11 whitespace-normal text-red-700 dark:text-red-400" disabled={busy} onClick={() => setFailing(true)}>
            {t('goals.pending.fail')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="foreman-goal-pending-answer" className="sr-only">
            {t('goals.pending.answerLabel')}
          </label>
          <textarea
            id="foreman-goal-pending-answer"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            maxLength={20000}
            placeholder={t('goals.pending.answerPlaceholder')}
            className={TEXTAREA}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-11 whitespace-normal" disabled={busy || !text.trim()} onClick={() => void send({ text: text.trim() })}>
              {t('goals.pending.send')}
            </Button>
            <Button variant="outline" className="h-11 whitespace-normal text-red-700 dark:text-red-400" disabled={busy} onClick={() => setFailing(true)}>
              {t('goals.pending.fail')}
            </Button>
          </div>
        </div>
      )}
      <ErrorLine message={error} />

      {failing && (
        <ConfirmDialog
          open
          title={t('goals.pending.failTitle')}
          description={t('goals.pending.failBody')}
          confirmLabel={t('goals.pending.fail')}
          cancelLabel={t('goals.keep')}
          tone="danger"
          onConfirm={async () => {
            await foremanTabApi.answer(pending.inboxId, failAnswer);
            setFailing(false);
            await onDone();
          }}
          onCancel={() => setFailing(false)}
        />
      )}
    </div>
  );
}

/** Pause, Resume and Cancel, each on only in the statuses Foreman accepts it. Cancel asks first. */
export function GoalControls({ goal, onDone }: { goal: GoalDetail; onDone: Done }) {
  const { t } = useTranslation('foreman');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const actions = goalActions(goal);

  const run = async (call: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call(goal.id);
      await onDone();
    } catch (failure) {
      setError(errorMessage(failure, t('common.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="foreman-goal-controls" className="min-w-0 space-y-1.5">
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" className="h-10 px-2" disabled={busy || !actions.canPause} onClick={() => void run(goalsApi.pause)}>
          {t('goals.controls.pause')}
        </Button>
        <Button variant="outline" className="h-10 px-2" disabled={busy || !actions.canResume} onClick={() => void run(goalsApi.resume)}>
          {t('goals.controls.resume')}
        </Button>
        <Button variant="outline" className="h-10 px-2 text-red-700 dark:text-red-400" disabled={busy || !actions.canCancel} onClick={() => setCancelling(true)}>
          {t('goals.controls.cancel')}
        </Button>
      </div>
      {actions.resumeNeedsAnswer && <p className="m-0 text-[11px] text-muted-foreground">{t('goals.controls.resumeNeedsAnswer')}</p>}
      <ErrorLine message={error} />

      {cancelling && (
        <ConfirmDialog
          open
          title={t('goals.controls.cancelTitle')}
          description={t('goals.controls.cancelBody')}
          confirmLabel={t('goals.controls.cancelConfirm')}
          cancelLabel={t('goals.keep')}
          tone="danger"
          onConfirm={async () => {
            await goalsApi.cancel(goal.id, reason.trim() || undefined);
            setCancelling(false);
            setReason('');
            await onDone();
          }}
          onCancel={() => setCancelling(false)}
        >
          <div className="space-y-1">
            <label htmlFor="foreman-goal-cancel-reason" className="block text-xs font-medium text-foreground/80">
              {t('goals.controls.cancelReason')}
            </label>
            <input
              id="foreman-goal-cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              autoComplete="off"
              className="h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-10 sm:text-sm"
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

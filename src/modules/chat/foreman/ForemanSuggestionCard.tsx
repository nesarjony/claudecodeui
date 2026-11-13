import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, HardHat, X } from 'lucide-react';

import { Button } from '@/shared/ui';
import {
  confidencePercent,
  foremanModelLabel,
  type ForemanExecution,
  type ForemanNotesView,
  type ForemanRisk,
  type ForemanSuggestion,
  type SuggestionPlan,
} from '@/modules/chat/foreman/foremanSuggestion';

type ForemanSuggestionCardProps = {
  suggestion: ForemanSuggestion;
  plan: SuggestionPlan;
  onSend: (text: string) => void;
  onEdit: (text: string) => void;
  onSwitchModel: (model: string) => void;
  onDismiss: () => void;
  /** Write notes / Hand off: the press in progress or its outcome, and the actions behind it. */
  execution?: ForemanExecution | null;
  notesView?: ForemanNotesView;
  onExecute?: () => void;
  onViewNotes?: () => void;
  onHideNotes?: () => void;
  /** Closes the card that reports what Foreman did. */
  onCloseExecution?: () => void;
  /** Opens a session in the chat: the fresh one a handoff started. */
  onOpenSession?: (sessionId: string) => void;
  /** Open or folded to start with. Default: open on a desktop-width screen, folded on a phone. */
  defaultOpen?: boolean;
};

const RISK_TONE: Record<ForemanRisk, string> = {
  low: 'text-emerald-600 dark:text-emerald-400',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-red-600 dark:text-red-400',
};

const CHIP =
  'inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 text-[11px] font-medium leading-5 tabular-nums';

const isPhoneWidth = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 640px)').matches;

/**
 * Rendered by ChatInterface above the composer: what Foreman, the supervisor, suggests doing next.
 *
 * It follows the redesigned chat's steps row: a one-line summary that folds open, a thin rail down the left of the
 * detail, sans-serif text, and the same tokens as the rest of the chat. Folded it is one line (title, action and a
 * clipped preview of the message) so it costs a phone almost no height; open it shows the proposed message, the
 * reason, a confidence and risk chip, the model that decided, and the buttons.
 */
export default function ForemanSuggestionCard({
  suggestion,
  plan,
  onSend,
  onEdit,
  onSwitchModel,
  onDismiss,
  execution,
  notesView = { phase: 'closed' },
  onExecute,
  onViewNotes,
  onHideNotes,
  onCloseExecution,
  onOpenSession,
  defaultOpen,
}: ForemanSuggestionCardProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(() => defaultOpen ?? !isPhoneWidth());
  const decision = suggestion.decision.decision;
  const actionLabel = t(`foreman.actions.${decision.action}`, { defaultValue: decision.action });
  const modelName = foremanModelLabel(suggestion.decision.model);

  const running = execution?.phase === 'running';
  const done = execution?.phase === 'done' ? execution : null;
  const preview = done
    ? done.action === 'write_notes'
      ? t('foreman.notesWritten', { version: done.notesVersion ?? '?' })
      : t('foreman.handedOff')
    : plan.kind === 'switch_model'
    ? t('foreman.switchTo', { model: foremanModelLabel(plan.alias), defaultValue: 'Switch to {{model}}' })
    : plan.text || decision.reason;

  return (
    <section
      aria-label={t('foreman.aria', { defaultValue: 'Foreman suggestion' })}
      data-testid="foreman-suggestion"
      data-action={decision.action}
      className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-border/60 bg-card/70 text-[13px] leading-5 backdrop-blur-sm"
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden />
          <HardHat className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="flex-shrink-0 font-medium text-foreground/80">
              {t('foreman.title', { defaultValue: 'Foreman suggests' })}
            </span>
            <span className="min-w-0 truncate">
              · {actionLabel}
              {!open && preview ? <span className="text-muted-foreground/70"> — {preview}</span> : null}
            </span>
          </span>
        </button>
        {!open && (
          <button
            type="button"
            onClick={done ? onCloseExecution : onDismiss}
            disabled={running}
            aria-label={t('foreman.dismiss', { defaultValue: 'Dismiss' })}
            title={t('foreman.dismiss', { defaultValue: 'Dismiss' })}
            className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {open && (
        <div className="mb-2.5 ml-[19px] mr-3 mt-0.5 space-y-2 border-l border-border/70 pl-3">
          {plan.kind === 'send' && (
            <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-foreground" data-testid="foreman-message">
              {plan.text}
            </p>
          )}
          {plan.kind === 'switch_model' && (
            <p className="text-sm leading-5 text-foreground" data-testid="foreman-message">
              {t('foreman.switchHint', {
                model: foremanModelLabel(plan.alias),
                defaultValue: 'Move this session to {{model}}.',
              })}
            </p>
          )}
          {plan.kind === 'execute' && (
            <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-foreground" data-testid="foreman-message">
              {plan.text}
            </p>
          )}
          {plan.kind === 'info' && (
            <>
              <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-foreground" data-testid="foreman-message">
                {plan.text}
              </p>
              {plan.unavailable && (
                <p className="text-xs italic text-muted-foreground" data-testid="foreman-unavailable">
                  {t('foreman.unavailable', { defaultValue: 'Not available in shadow mode yet' })}
                </p>
              )}
            </>
          )}

          {decision.reason && plan.kind !== 'info' && plan.kind !== 'execute' && (
            <p className="line-clamp-3 break-words text-xs text-muted-foreground" data-testid="foreman-reason">
              <span className="font-medium text-foreground/70">{t('foreman.why', { defaultValue: 'Why' })}:</span> {decision.reason}
            </p>
          )}
          {decision.reason && plan.kind === 'info' && plan.text !== decision.reason && (
            <p className="line-clamp-3 break-words text-xs text-muted-foreground" data-testid="foreman-reason">
              <span className="font-medium text-foreground/70">{t('foreman.why', { defaultValue: 'Why' })}:</span> {decision.reason}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className={CHIP} data-testid="foreman-confidence" title={t('foreman.confidenceTitle', { defaultValue: 'How sure Foreman is' })}>
              {t('foreman.confidence', { percent: confidencePercent(decision.confidence), defaultValue: '{{percent}}% sure' })}
            </span>
            <span className={`${CHIP} ${RISK_TONE[decision.risk]}`} data-testid="foreman-risk">
              {t(`foreman.risk.${decision.risk}`, { defaultValue: `${decision.risk} risk` })}
            </span>
            <span className={`${CHIP} text-muted-foreground`} data-testid="foreman-model">
              {suggestion.decision.escalated
                ? t('foreman.secondOpinion', { model: modelName, defaultValue: '{{model}} · 2nd opinion' })
                : modelName}
            </span>
          </div>

          {done ? (
            <div className="space-y-2" data-testid="foreman-execution-done">
              <p className="text-sm leading-5 text-foreground" data-testid="foreman-execution-result">
                {done.action === 'write_notes' ? t('foreman.notesWritten', { version: done.notesVersion ?? '?' }) : t('foreman.handedOff')}
              </p>
              {done.action === 'write_notes' && (
                <button
                  type="button"
                  onClick={notesView.phase === 'closed' ? onViewNotes : onHideNotes}
                  className="text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid="foreman-view-notes"
                >
                  {notesView.phase === 'closed' ? t('foreman.viewNotes', { defaultValue: 'View notes' }) : t('foreman.hideNotes', { defaultValue: 'Hide notes' })}
                </button>
              )}
              {notesView.phase === 'loading' && <p className="text-xs text-muted-foreground">{t('foreman.notesLoading', { defaultValue: 'Loading the notes…' })}</p>}
              {notesView.phase === 'empty' && <p className="text-xs text-muted-foreground">{t('foreman.notesEmpty', { defaultValue: 'No notes found for this session.' })}</p>}
              {notesView.phase === 'failed' && <p className="text-xs text-red-600 dark:text-red-400">{t('foreman.notesFailed', { defaultValue: 'The notes could not be loaded.' })}</p>}
              {notesView.phase === 'ready' && (
                <pre
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-2 font-sans text-xs leading-5 text-foreground"
                  data-testid="foreman-notes"
                >
                  {notesView.notes.content}
                </pre>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {done.action === 'handoff' && done.newSessionId && onOpenSession && (
                  <Button size="sm" onClick={() => onOpenSession(done.newSessionId!)}>
                    {t('foreman.openSession', { defaultValue: 'Open the new session' })}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={onCloseExecution}>
                  {t('foreman.close', { defaultValue: 'Close' })}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {execution?.phase === 'failed' && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400" data-testid="foreman-execution-error">
                  {t('foreman.execute.failed', { message: execution.error, defaultValue: 'That did not work: {{message}}' })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {plan.kind === 'send' && (
                  <>
                    <Button size="sm" onClick={() => onSend(plan.text)}>
                      {t('foreman.send', { defaultValue: 'Send' })}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onEdit(plan.text)}>
                      {t('foreman.edit', { defaultValue: 'Edit' })}
                    </Button>
                  </>
                )}
                {plan.kind === 'switch_model' && (
                  <Button size="sm" onClick={() => onSwitchModel(plan.model)}>
                    {t('foreman.switchTo', { model: foremanModelLabel(plan.alias), defaultValue: 'Switch to {{model}}' })}
                  </Button>
                )}
                {plan.kind === 'execute' && (
                  <Button size="sm" onClick={onExecute} disabled={running} data-testid="foreman-execute">
                    {running ? t('foreman.execute.working', { defaultValue: 'Working…' }) : t(`foreman.execute.${plan.action}`, { defaultValue: plan.action })}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={onDismiss} disabled={running}>
                  {t('foreman.dismiss', { defaultValue: 'Dismiss' })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

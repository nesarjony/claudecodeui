import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, LLMProvider,DiffLine,DiffStats,Project,ToolGroupItem } from '@/shared/types';
import { Shimmer } from '@/shared/ui';
import { getToolConfig } from '@/modules/chat/tools';
import MessageComponent, { AssistantTurnHeader } from '@/modules/chat/transcript/MessageComponent';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';
import {
  describeStep,
  getStepsDurationMs,
  isFailedStep,
  summarizeStepKinds,
} from '@/modules/chat/utils/toolGrouping';

type ToolGroupContainerProps = {
  group: ToolGroupItem;
  /** True when the run opens an assistant turn, so the row draws the turn's header. */
  opensTurn: boolean;
  /**
   * True for the newest run while the session is still working. The row then
   * shows the step in flight instead of the summary.
   */
  isLive?: boolean;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
};

/**
 * Totals the lines the run's file edits added and removed, so a folded run of
 * edits still says how big it was. Null when no step in it renders a diff.
 */
function useStepsDiffStats(
  steps: ChatMessage[],
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
): DiffStats | null {
  return useMemo(() => {
    let added = 0;
    let removed = 0;
    let counted = 0;

    for (const step of steps) {
      const config = getToolConfig(step.toolName || '').input;
      if (config.contentType !== 'diff' || !config.getContentProps) {
        continue;
      }

      const contentProps = config.getContentProps(parseToolPayload(step.toolInput) ?? {});
      if (typeof contentProps?.oldContent !== 'string' || typeof contentProps?.newContent !== 'string') {
        continue;
      }

      const stats = summarizeDiff(createDiff(contentProps.oldContent, contentProps.newContent));
      added += stats.added;
      removed += stats.removed;
      counted += 1;
    }

    return counted > 0 ? { added, removed } : null;
  }, [createDiff, steps]);
}

/**
 * Rendered by chat's ChatMessagesPane (and the transcript export) as the
 * "steps" row: a run of consecutive tool calls folded into one line —
 * `▸ 12 steps · Read ×6 · Search ×4   41s` — that expands to the per-tool rows.
 *
 * While its run is the live end of a working session it shows the step in
 * flight (`◌ Editing implement-parity/SKILL.md…`) in the same line, so the run
 * finishing swaps the line's text without changing its height. Failed steps
 * stay visible below the folded line.
 */
function ToolGroupContainer({
  group,
  opensTurn,
  isLive = false,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: ToolGroupContainerProps) {
  const { t } = useTranslation('chat');
  const isExporting = useIsExportingTranscript();
  // Folded on screen, always open in an export: the row exists to hide detail
  // the reader can ask for, and an exported file has no way to ask.
  const [isExpanded, setIsExpanded] = useState(false);
  const showSteps = isExpanded || isExporting;

  const { steps } = group;
  const stepCount = steps.length;
  const failedSteps = useMemo(() => steps.filter(isFailedStep), [steps]);
  const diffStats = useStepsDiffStats(steps, createDiff);

  const headline = useMemo(() => {
    if (isLive) {
      return describeStep(steps[stepCount - 1], 'active');
    }
    return stepCount === 1
      ? describeStep(steps[0], 'done')
      : t('steps.count', { count: stepCount, defaultValue: '{{count}} steps' });
  }, [isLive, stepCount, steps, t]);

  const kindsSummary = useMemo(
    () => (stepCount > 1 ? summarizeStepKinds(steps) : ''),
    [stepCount, steps],
  );

  const durationLabel = useMemo(() => {
    const durationMs = getStepsDurationMs(steps);
    if (durationMs === null || durationMs < 1000) return null;
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes < 1
      ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  }, [steps, t]);

  const renderStep = (message: ChatMessage, previous: ChatMessage | null) => (
    <MessageComponent
      key={getMessageKey(message)}
      message={message}
      // Steps are continuation rows: this row already opened the turn, so
      // each one is passed an assistant predecessor and draws no header or
      // timestamp of its own.
      prevMessage={previous ?? message}
      createDiff={createDiff}
      onFileOpen={onFileOpen}
      onShowSettings={onShowSettings}
      onGrantToolPermission={onGrantToolPermission}
      showRawParameters={showRawParameters}
      showThinking={showThinking}
      selectedProject={selectedProject}
      provider={provider}
    />
  );

  return (
    <div className="chat-message steps px-3 sm:px-0" data-message-timestamp={group.timestamp || undefined}>
      {opensTurn && <AssistantTurnHeader provider={provider} />}

      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={showSteps}
        // The live row sits at the end the view is following; opening it is
        // watching it, not reading back (see useTranscriptFollow).
        data-follow-on-expand={isLive ? '' : undefined}
        className="-mx-2 flex min-h-9 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center" aria-hidden>
          {isLive ? (
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-primary" />
          ) : (
            <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-150 ${showSteps ? 'rotate-90' : ''}`} />
          )}
        </span>

        {isLive ? (
          <Shimmer className="min-w-0 flex-1 truncate">{`${headline}…`}</Shimmer>
        ) : (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className={`font-medium text-foreground/80 ${stepCount === 1 ? 'min-w-0 truncate' : 'flex-shrink-0'}`}>
              {headline}
            </span>
            {kindsSummary && (
              <span className="min-w-0 truncate">· {kindsSummary}</span>
            )}
          </span>
        )}

        {failedSteps.length > 0 && (
          <span className="flex-shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
            · {t('steps.failed', { count: failedSteps.length, defaultValue: '{{count}} failed' })}
          </span>
        )}
        {isLive ? (
          stepCount > 1 && (
            <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground/70">
              {t('steps.count', { count: stepCount, defaultValue: '{{count}} steps' })}
            </span>
          )
        ) : (
          <>
            {diffStats && <DiffStatsBadge stats={diffStats} className="flex-shrink-0" />}
            {durationLabel && (
              <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground/70">{durationLabel}</span>
            )}
          </>
        )}
      </button>

      {showSteps ? (
        <div className="mb-1 ml-[7px] mt-1 space-y-1.5 border-l border-border/70 pl-3 [&>.chat-message]:px-0">
          {group.messages.map((message, index) => renderStep(message, index > 0 ? group.messages[index - 1] : null))}
        </div>
      ) : failedSteps.length > 0 && (
        // Kept out of the fold: a failure is something the user may need to
        // act on, and the agent may not have recovered from it.
        <div className="mb-1 ml-[7px] mt-1 space-y-1.5 border-l border-red-500/40 pl-3 [&>.chat-message]:px-0">
          {failedSteps.map((message) => renderStep(message, null))}
        </div>
      )}
    </div>
  );
}

/**
 * Re-renders only when the run itself changes.
 *
 * Grouping rebuilds every group object (and the pane rebuilds `getMessageKey`)
 * from a fresh message array on each 100ms stream tick, so default shallow
 * comparison never bailed out and every steps row re-rendered while text
 * streamed below it. The run's messages are stable objects between ticks
 * (useChatMessages reuses their projections), so comparing them by identity
 * is exact. `getMessageKey` is skipped: it derives keys from those same
 * messages, so equal messages produce equal keys.
 */
function areStepsRowPropsEqual(previous: ToolGroupContainerProps, next: ToolGroupContainerProps): boolean {
  const previousMessages = previous.group.messages;
  const nextMessages = next.group.messages;
  if (previousMessages.length !== nextMessages.length) return false;
  for (let index = 0; index < nextMessages.length; index += 1) {
    if (previousMessages[index] !== nextMessages[index]) return false;
  }

  return previous.opensTurn === next.opensTurn
    && previous.isLive === next.isLive
    && previous.createDiff === next.createDiff
    && previous.onFileOpen === next.onFileOpen
    && previous.onShowSettings === next.onShowSettings
    && previous.onGrantToolPermission === next.onGrantToolPermission
    && previous.showRawParameters === next.showRawParameters
    && previous.showThinking === next.showThinking
    && previous.selectedProject === next.selectedProject
    && previous.provider === next.provider;
}

export default memo(ToolGroupContainer, areStepsRowPropsEqual);

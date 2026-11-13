import { useTranslation } from 'react-i18next';
import { memo, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { groupTranscriptSteps, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

const NO_ENTERING_ROWS: ReadonlySet<string> = new Set();

/**
 * The rows that were appended at the live end since the previous key list —
 * the only rows that ease in.
 *
 * Bounded by how much the list grew, so a history refresh that swaps a live
 * row for its persisted twin (same place, new key) does not replay the
 * animation on it, and prepended history (new keys at the top) never counts.
 * A list sharing no key with the previous one is a different transcript
 * opening, which appears as a whole.
 */
function findAppendedRowKeys(previousKeys: string[], nextKeys: string[]): ReadonlySet<string> {
  const growth = nextKeys.length - previousKeys.length;
  if (previousKeys.length === 0 || growth <= 0) {
    return NO_ENTERING_ROWS;
  }

  const known = new Set(previousKeys);
  const appended = new Set<string>();
  for (let index = nextKeys.length - 1; index >= 0 && appended.size < growth; index -= 1) {
    if (known.has(nextKeys[index])) break;
    appended.add(nextKeys[index]);
  }
  return appended.size === nextKeys.length ? NO_ENTERING_ROWS : appended;
}

/**
 * Tracks which row keys just arrived, derived while rendering from the
 * previous key list (React's "storing information from previous renders"
 * pattern). Compared by a joined signature, so the per-tick re-renders of a
 * streaming reply — same keys, fresh array — cost a string compare and no
 * extra render.
 */
function useEnteringRowKeys(rowKeys: string[]): ReadonlySet<string> {
  const signature = rowKeys.join('\n');
  // The key list of the previous change and the rows that change appended.
  const [tracked, setTracked] = useState({ signature, keys: rowKeys, entering: NO_ENTERING_ROWS });
  if (tracked.signature === signature) {
    return tracked.entering;
  }

  const entering = findAppendedRowKeys(tracked.keys, rowKeys);
  setTracked({ signature, keys: rowKeys, entering });
  return entering;
}

type ChatMessagesPaneProps = {
  /** Incremented for every explicit New Session click, including repeated clicks on a blank composer. */
  newSessionTrigger?: number;
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The row column; the transcript's follow logic watches its height. */
  scrollContentRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  newSessionTrigger,
  scrollContainerRef,
  scrollContentRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const groupedVisibleMessages = useMemo(
    () => groupTranscriptSteps(visibleMessages),
    [visibleMessages],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  const rowKeys = useMemo(
    () => groupedVisibleMessages.map((item) => (
      isToolGroupItem(item) ? `tool-group-${getMessageKey(item.messages[0])}` : getMessageKey(item)
    )),
    [getMessageKey, groupedVisibleMessages],
  );
  const enteringRowKeys = useEnteringRowKeys(rowKeys);

  // The steps row that shows the step in flight: the last row the user can
  // see, while the session works. Hidden reasoning after it renders nothing,
  // so it does not end the run as far as the user is concerned.
  const liveRowIndex = useMemo(() => {
    if (!isProcessing) return -1;
    for (let index = groupedVisibleMessages.length - 1; index >= 0; index -= 1) {
      const item = groupedVisibleMessages[index];
      if (isToolGroupItem(item)) return index;
      if (!(item.isThinking && !showThinking)) return -1;
    }
    return -1;
  }, [groupedVisibleMessages, isProcessing, showThinking]);

  // The nearest enclosing header that offers a chat-actions slot (the split
  // pane's row, or the single view's workspace header).
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    let scope = scrollContainerRef.current?.closest('[data-chat-scope]') ?? null;
    let slot: HTMLElement | null = null;
    while (scope && !slot) {
      slot = scope.querySelector<HTMLElement>('[data-chat-header-actions]');
      if (!slot) scope = scope.parentElement?.closest('[data-chat-scope]') ?? null;
    }
    setHeaderActionsSlot(slot);
  }, [scrollContainerRef]);

  const exportMenu = chatMessages.length > 0 ? (
    <ChatExportMenu
      messages={chatMessages}
      sessionTitle={selectedSession?.summary || selectedSession?.title}
      provider={provider}
      selectedProject={selectedProject}
      createDiff={createDiff}
      onLoadFullTranscript={onLoadFullTranscript}
    />
  ) : null;

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {exportMenu && headerActionsSlot && createPortal(exportMenu, headerActionsSlot)}
      {exportMenu && !headerActionsSlot && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
          <div className="pointer-events-auto">{exportMenu}</div>
        </div>
      )}
      <div ref={scrollContentRef} className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          newSessionTrigger={newSessionTrigger}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            const rowCount = groupedVisibleMessages.length;

            return groupedVisibleMessages.map((item, index) => {
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= rowCount - INITIAL_MOUNTED_TAIL_ROWS;

              const rowKey = rowKeys[index];

              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <LazyMessageRow
                    key={rowKey}
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                    animateEntry={enteringRowKeys.has(rowKey)}
                    foldedTimestamps={item.messages.map((message) => String(message.timestamp)).join('|')}
                  >
                    <ToolGroupContainer
                      group={item}
                      opensTurn={groupPrevMessage?.type !== 'assistant'}
                      isLive={index === liveRowIndex}
                      createDiff={createDiff}
                      getMessageKey={getMessageKey}
                      onFileOpen={onFileOpen}
                      onShowSettings={onShowSettings}
                      onGrantToolPermission={onGrantToolPermission}
                      showRawParameters={showRawParameters}
                      showThinking={showThinking}
                      selectedProject={selectedProject}
                      provider={provider}
                    />
                  </LazyMessageRow>
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              return (
                <LazyMessageRow
                  key={rowKey}
                  lazyRows={lazyRows}
                  timestamp={item.timestamp}
                  initiallyNearViewport={initiallyNearViewport}
                  animateEntry={enteringRowKeys.has(rowKey)}
                >
                  <MessageComponent
                    message={item}
                    prevMessage={messagePrevMessage}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                  />
                </LazyMessageRow>
              );
            });
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';

type PaneState = 'working' | 'waiting' | 'failed' | 'new' | 'idle';

type ChatHeaderStatusProps = {
  isProcessing: boolean;
  /** Client-clock start of the current turn, from the session activity. */
  startedAt: number | null;
  waitingCount: number;
  lastMessageType: string | null;
  lastMessageAt: string | number | Date | null;
};

/**
 * Finds a slot in the nearest enclosing header (split pane row or single-view
 * workspace header) so chat state can be shown there instead of costing the
 * transcript a row. Null when no header offers the slot.
 */
export function useChatHeaderSlot(anchorRef: RefObject<HTMLElement>, slotAttribute: string): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    let scope = anchorRef.current?.closest('[data-chat-scope]') ?? null;
    let found: HTMLElement | null = null;
    while (scope && !found) {
      found = scope.querySelector<HTMLElement>(`[${slotAttribute}]`);
      if (!found) scope = scope.parentElement?.closest('[data-chat-scope]') ?? null;
    }
    setSlot(found);
  }, [anchorRef, slotAttribute]);
  return slot;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function formatAgo(timestamp: string | number | Date | null): string {
  if (timestamp === null) return '';
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const STYLES: Record<PaneState, string> = {
  working: 'bg-primary/10 text-primary',
  waiting: 'bg-amber-500/15 text-amber-500',
  failed: 'bg-red-500/10 text-red-500',
  new: 'bg-emerald-500/10 text-emerald-500',
  idle: 'text-muted-foreground',
};

/**
 * The session's state as a chip in its header: working (with elapsed time),
 * waiting for you, failed, finished since you last touched the pane, or idle.
 * The chip's `data-pane-state` also tints the pane border (see index.css).
 */
function ChatHeaderStatus({ isProcessing, startedAt, waitingCount, lastMessageType, lastMessageAt }: ChatHeaderStatusProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const slot = useChatHeaderSlot(anchorRef, 'data-chat-header-status');
  const [now, setNow] = useState(() => Date.now());
  const [finishedUnseen, setFinishedUnseen] = useState(false);
  const wasProcessing = useRef(isProcessing);

  // A turn that ends while you are elsewhere stays marked until you touch this pane.
  useEffect(() => {
    if (wasProcessing.current && !isProcessing) setFinishedUnseen(true);
    if (isProcessing) setFinishedUnseen(false);
    wasProcessing.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    if (!finishedUnseen) return;
    const scope = anchorRef.current?.closest('.pane-chat') ?? anchorRef.current?.closest('[data-chat-scope]');
    if (!scope) return;
    const seen = () => setFinishedUnseen(false);
    scope.addEventListener('pointerdown', seen);
    return () => scope.removeEventListener('pointerdown', seen);
  }, [finishedUnseen]);

  const state: PaneState = waitingCount > 0
    ? 'waiting'
    : isProcessing
      ? 'working'
      : lastMessageType === 'error'
        ? 'failed'
        : finishedUnseen
          ? 'new'
          : 'idle';

  // Elapsed time ticks every second while working; idle age once a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), state === 'working' ? 1000 : 60000);
    return () => clearInterval(timer);
  }, [state]);

  const idleAgo = formatAgo(lastMessageAt);
  const content = (
    <span
      data-pane-state={state}
      title={state === 'waiting' ? `${waitingCount} request${waitingCount === 1 ? '' : 's'} waiting for you` : undefined}
      className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium tabular-nums ${STYLES[state]}`}
    >
      {state === 'working' && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          {startedAt ? formatElapsed(now - startedAt) : 'Working'}
        </>
      )}
      {state === 'waiting' && (
        <>
          <AlertCircle className="h-3 w-3" /> Waiting for you
        </>
      )}
      {state === 'failed' && (
        <>
          <XCircle className="h-3 w-3" /> Failed
        </>
      )}
      {state === 'new' && (
        <>
          <CheckCircle2 className="h-3 w-3" /> Done
        </>
      )}
      {state === 'idle' && <>{idleAgo ? `Idle ${idleAgo}` : 'Idle'}</>}
    </span>
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {slot && createPortal(content, slot)}
    </>
  );
}

export default memo(ChatHeaderStatus);

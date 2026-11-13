import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, CircleStop, Cog, Loader2, Square, X, XCircle } from 'lucide-react';

import type { BackgroundShell, BackgroundShellStatus } from '@/modules/chat/agents/useSessionAgents';

type BackgroundBarProps = {
  shells: BackgroundShell[];
  sessionName: string | null;
  isDesktop: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStop: (taskId: string) => Promise<boolean>;
};

const STATUS: Record<BackgroundShellStatus, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  running: { icon: Loader2, tone: 'text-primary' },
  done: { icon: CheckCircle2, tone: 'text-emerald-500' },
  failed: { icon: XCircle, tone: 'text-red-500' },
  stopped: { icon: CircleStop, tone: 'text-muted-foreground' },
};

// Whole minutes once past a minute: the list refreshes every few seconds, so
// seconds would only jump.
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function shellTitle(shell: BackgroundShell): string {
  return shell.description || shell.command.replace(/\s+/g, ' ').trim().slice(0, 200) || shell.taskId;
}

/**
 * Background shells and monitors of one chat session: a `⚙ N` chip (N running;
 * muted once everything has finished) that opens a panel — bottom sheet on
 * phones, side drawer on desktop — with each one's status, last output lines
 * and a Stop button while it runs.
 */
export default function BackgroundBar({ shells, sessionName, isDesktop, open, onOpenChange, onStop }: BackgroundBarProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  const running = shells.filter((shell) => shell.status === 'running').length;
  const failed = shells.filter((shell) => shell.status === 'failed').length;
  const label =
    running > 0
      ? `${running} running in the background`
      : `${shells.length} finished in the background${failed > 0 ? `, ${failed} failed` : ''}`;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label={`Open background panel: ${label}`}
        title={`Background: ${label}`}
        className={
          // Compact on phones, where the header is crowded; the ::after strip
          // widens the tap target to 40px without growing the header.
          "relative flex h-6 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 text-[11px] font-medium tabular-nums transition after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] sm:gap-1 sm:px-2 " +
          (running > 0
            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
            : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted')
        }
      >
        <Cog className="h-3 w-3" />
        {running > 0 ? running : shells.length}
      </button>

      {open &&
        createPortal(
          <BackgroundPanel
            shells={shells}
            sessionName={sessionName}
            isDesktop={isDesktop}
            onClose={() => onOpenChange(false)}
            onStop={onStop}
          />,
          document.body,
        )}
    </>
  );
}

type BackgroundPanelProps = {
  shells: BackgroundShell[];
  sessionName: string | null;
  isDesktop: boolean;
  onClose: () => void;
  onStop: (taskId: string) => Promise<boolean>;
};

function BackgroundPanel({ shells, sessionName, isDesktop, onClose, onStop }: BackgroundPanelProps) {
  return (
    <>
      <div className="fixed inset-0 z-[160] bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="Background"
        className={
          isDesktop
            ? 'fixed inset-y-0 right-0 z-[161] flex w-[28rem] max-w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-2xl'
            : 'fixed inset-x-0 bottom-0 z-[161] flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-border bg-popover pb-safe-area-inset-bottom text-popover-foreground shadow-2xl'
        }
      >
        {!isDesktop && (
          <div className="flex shrink-0 justify-center pt-2" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Cog className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="min-w-0 truncate text-sm font-semibold">
            Background
            {sessionName && <span className="font-normal text-muted-foreground"> · {sessionName}</span>}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2">
          {shells.map((shell) => (
            <ShellCard key={shell.taskId} shell={shell} onStop={onStop} />
          ))}
          {shells.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">Nothing in the background in this stretch.</p>
          )}
        </div>
      </div>
    </>
  );
}

function ShellCard({ shell, onStop }: { shell: BackgroundShell; onStop: (taskId: string) => Promise<boolean> }) {
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const { icon: Icon, tone } = STATUS[shell.status];
  const title = shellTitle(shell);
  const isRunning = shell.status === 'running';
  const exitNote = shell.status === 'failed' && shell.exitCode !== null ? `exit code ${shell.exitCode}` : null;
  const notes = [
    shell.kind === 'monitor' && 'monitor',
    shell.movedToBackground && 'moved to the background after its timeout',
  ].filter((note): note is string => Boolean(note));

  // A stopped shell keeps showing as running until its report lands (a poll or
  // two later), so the button stays in "Stopping…" for a while after success.
  const stop = async () => {
    setStopping(true);
    setStopFailed(false);
    const stopped = await onStop(shell.taskId).catch(() => false);
    if (stopped) {
      setTimeout(() => setStopping(false), 10_000);
    } else {
      setStopping(false);
      setStopFailed(true);
    }
  };

  return (
    <div
      className={
        'rounded-xl border p-3 ' +
        (isRunning ? 'border-primary/40 bg-primary/[0.04]' : 'border-border/60 bg-card/40')
      }
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone} ${isRunning ? 'animate-spin' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-sm font-medium text-foreground" title={shell.command || title}>
            {title}
          </div>
          {shell.description && shell.command && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={shell.command}>
              {shell.command}
            </div>
          )}
        </div>
        <span className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${isRunning ? 'text-primary' : 'text-muted-foreground'}`}>
          {shell.status}
          {(isRunning || shell.durationMs > 0) && ` ${formatDuration(shell.durationMs)}`}
        </span>
      </div>

      {(notes.length > 0 || exitNote) && (
        <div className="mt-1 flex flex-wrap gap-x-2 pl-6 text-[11px] text-muted-foreground">
          {exitNote && <span className="text-red-500">{exitNote}</span>}
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </div>
      )}

      {shell.outputTail.length > 0 && (
        <div className="ml-6 mt-2 space-y-0.5 border-l-2 border-border/70 pl-2 font-mono text-[11px] leading-snug text-muted-foreground">
          {shell.outputTail.map((line, index) => (
            <div key={index} className="line-clamp-2 whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
        </div>
      )}

      {isRunning && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {stopFailed && <span className="text-[11px] text-amber-500">Not running in a live session</span>}
          <button
            type="button"
            disabled={stopping}
            onClick={stop}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-xs font-medium text-foreground transition hover:border-red-500/60 hover:text-red-500 disabled:opacity-50 sm:h-7"
          >
            <Square className="h-3.5 w-3.5" /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
    </div>
  );
}

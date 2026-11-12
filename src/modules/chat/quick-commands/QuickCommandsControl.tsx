import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, Settings2, Wand2, X, Zap } from 'lucide-react';

import { useQuickCommands, type QuickCommand } from '@/modules/chat/hooks/useQuickCommands';
import QuickCommandManager from '@/modules/chat/quick-commands/QuickCommandManager';

type MinimalMsg = {
  type?: string;
  content?: string;
  displayText?: string;
  [k: string]: unknown;
};

type QuickCommandsControlProps = {
  setInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  chatMessages: MinimalMsg[];
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};

type CommandGroup = { key: string; title: string; commands: QuickCommand[] };

const MAX_TOOLBAR_PINS = 4;
// Space kept between the toolbar's left tools and its right-hand controls.
const TOOLBAR_SLACK_PX = 16;
const POPOVER_WIDTH_PX = 384;

const PIN_CHIP_CLASS =
  'flex h-8 max-w-36 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs font-medium text-foreground';

const isPromptCommand = (cmd: QuickCommand) => Boolean(cmd.prompt && cmd.prompt.trim());

/** Groups commands for the palette: pinned first, then plain text, AI prompts and slash commands. */
function groupCommands(commands: QuickCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = [
    { key: 'pinned', title: 'Pinned', commands: [] },
    { key: 'commands', title: 'Commands', commands: [] },
    { key: 'ai', title: 'AI', commands: [] },
    { key: 'session', title: 'Session', commands: [] },
  ];
  const [pinned, plain, ai, session] = groups;
  for (const cmd of commands) {
    if (cmd.pinned) pinned.commands.push(cmd);
    else if (isPromptCommand(cmd)) ai.commands.push(cmd);
    else if (cmd.body.trim().startsWith('/')) session.commands.push(cmd);
    else plain.commands.push(cmd);
  }
  return groups.filter((group) => group.commands.length > 0);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Whether the pinned chips fit on the composer toolbar's single row beside the
 * other tools and the right-hand controls. Measured from the real toolbar (an
 * off-screen copy of the chips gives their width), so it holds at any pane width
 * and never pushes the send controls onto a second row.
 */
function usePinsFit(
  triggerRef: React.RefObject<HTMLElement>,
  measureRef: React.RefObject<HTMLElement>,
  pinsKey: string,
): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const tools = triggerRef.current?.closest<HTMLElement>('[data-slot="prompt-input-tools"]');
    const footer = tools?.closest<HTMLElement>('[data-slot="prompt-input-footer"]');
    const measure = measureRef.current;
    if (!tools || !footer || !measure) {
      setFits(false);
      return;
    }
    const actions = Array.from(footer.children).find(
      (child) => child !== tools && !child.classList.contains('basis-full'),
    ) as HTMLElement | undefined;
    const update = () => {
      const toolsGap = parseFloat(getComputedStyle(tools).columnGap) || 0;
      const toolsWithoutPins = Array.from(tools.children).reduce((sum, child) => {
        if ((child as HTMLElement).dataset.quickPins !== undefined) return sum;
        return sum + child.getBoundingClientRect().width + toolsGap;
      }, 0);
      const footerStyle = getComputedStyle(footer);
      const innerWidth =
        footer.clientWidth - parseFloat(footerStyle.paddingLeft) - parseFloat(footerStyle.paddingRight);
      const available =
        innerWidth - toolsWithoutPins - (actions?.getBoundingClientRect().width ?? 0) - TOOLBAR_SLACK_PX;
      setFits(measure.scrollWidth > 0 && measure.scrollWidth <= available);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(footer);
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [triggerRef, measureRef, pinsKey]);
  return fits;
}

/**
 * Quick commands for one chat pane: a toolbar button that opens a palette
 * (bottom sheet on phones, popover on desktop) plus one-tap pinned chips when
 * the composer is wide. All open/closed state is local, so panes never affect
 * each other.
 */
function QuickCommandsControl({ setInput, textareaRef, chatMessages, onSubmit }: QuickCommandsControlProps) {
  const { commands, settings, create, update, remove, saveSettings, runCommand } = useQuickCommands();
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [runningId, setRunningId] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pinsMeasureRef = useRef<HTMLDivElement>(null);
  const isDesktop = useMediaQuery('(min-width: 640px)');
  const sendByDefault = settings.send_mode === 'direct';

  const lastAssistantText = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m?.type === 'assistant') {
        const text =
          (typeof m.displayText === 'string' && m.displayText) ||
          (typeof m.content === 'string' && m.content) ||
          '';
        if (text.trim()) return text;
      }
    }
    return '';
  }, [chatMessages]);

  const close = useCallback(() => {
    setOpen(false);
    setFilter('');
  }, []);

  const togglePalette = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH_PX - 8)),
        bottom: window.innerHeight - rect.top + 8,
      });
    }
    if (open) close();
    else setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // Desktop starts typing into the filter; phones keep the keyboard down so the
  // sheet stays fully visible.
  useEffect(() => {
    if (open && isDesktop) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, isDesktop]);

  const focusComposer = () => requestAnimationFrame(() => textareaRef.current?.focus());
  const submitSoon = () => {
    // Deferred so React commits setInput before the composer reads it on submit.
    setTimeout(
      () => onSubmit?.({ preventDefault: () => undefined } as unknown as React.FormEvent<HTMLFormElement>),
      0,
    );
  };

  const runQuickCommand = async (cmd: QuickCommand, send: boolean) => {
    close();
    const finish = () => (send && onSubmit ? submitSoon() : focusComposer());
    if (isPromptCommand(cmd)) {
      if (runningId != null) return;
      setRunningId(cmd.id);
      const text = await runCommand(cmd.id, lastAssistantText);
      setRunningId(null);
      if (text && text.trim()) {
        setInput(text);
        finish();
      } else {
        focusComposer();
      }
      return;
    }
    setInput((prev) => {
      if (cmd.body.includes('{input}')) return cmd.body.replace(/\{input\}/g, prev.trim());
      return prev.trim() ? `${prev.replace(/\s+$/, '')}\n${cmd.body}` : cmd.body;
    });
    finish();
  };

  const query = filter.trim().toLowerCase();
  const matching = query
    ? commands.filter((cmd) => cmd.label.toLowerCase().includes(query) || cmd.body.toLowerCase().includes(query))
    : commands;
  const groups = groupCommands(matching);
  const pins = commands.filter((cmd) => cmd.pinned).slice(0, MAX_TOOLBAR_PINS);
  const pinsFit = usePinsFit(triggerRef, pinsMeasureRef, pins.map((cmd) => cmd.id).join(','));

  const onFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = groups[0]?.commands[0];
    if (first) void runQuickCommand(first, event.shiftKey ? !sendByDefault : sendByDefault);
  };

  const renderCommand = (cmd: QuickCommand) => (
    <button
      key={cmd.id}
      type="button"
      onClick={() => void runQuickCommand(cmd, sendByDefault)}
      disabled={runningId === cmd.id}
      title={isPromptCommand(cmd) ? `AI: ${cmd.prompt}` : cmd.body}
      className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-left text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:opacity-60 sm:min-h-9 sm:text-xs"
    >
      {cmd.emoji ? <span className="shrink-0 text-base leading-none sm:text-sm">{cmd.emoji}</span> : null}
      <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
      {isPromptCommand(cmd) ? <Wand2 className="h-3.5 w-3.5 shrink-0 text-primary/80" /> : null}
    </button>
  );

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Quick commands"
      style={isDesktop && anchor ? { left: anchor.left, bottom: anchor.bottom, width: POPOVER_WIDTH_PX } : undefined}
      className={
        isDesktop
          ? 'fixed z-[150] flex max-h-[min(30rem,70vh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl'
          : 'fixed inset-x-0 bottom-0 z-[150] flex max-h-[80dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-2xl'
      }
    >
      {!isDesktop && (
        <div className="flex justify-center pt-2" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border/60 p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter commands"
            enterKeyHint="go"
            className="h-10 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-base outline-none focus:border-primary/60 sm:h-9 sm:text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            close();
            setManagerOpen(true);
          }}
          aria-label="Manage quick commands"
          title="Manage quick commands"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground sm:h-9 sm:w-9"
        >
          <Settings2 className="h-4 w-4" />
        </button>
        {!isDesktop && (
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {groups.map((group) => (
          <section key={group.key} className="mb-3 last:mb-0">
            <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h3>
            <div className="grid grid-cols-2 gap-1.5">{group.commands.map(renderCommand)}</div>
          </section>
        ))}
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {commands.length === 0 ? 'No quick commands yet. Tap ⚙ to add one.' : 'No commands match.'}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 p-2">
        <span className="shrink-0 text-xs text-muted-foreground">Tap to</span>
        <div className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-muted/50 p-0.5">
          {(
            [
              { value: 'direct', label: 'Send' },
              { value: 'insert', label: 'Insert' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void saveSettings({ send_mode: option.value })}
              aria-pressed={settings.send_mode === option.value}
              className={
                'h-9 rounded-md text-xs font-medium transition sm:h-7 ' +
                (settings.send_mode === option.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {isDesktop && <span className="shrink-0 text-[10px] text-muted-foreground">⇧⏎ other</span>}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePalette}
        aria-label="Quick commands"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Quick commands"
        className={
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted hover:text-foreground ' +
          (open ? 'bg-muted text-foreground' : 'text-muted-foreground')
        }
      >
        {runningId != null ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Zap className="h-4 w-4" />}
      </button>

      {isDesktop && pins.length > 0 && (
        <>
          <div data-quick-pins="" aria-hidden className="relative h-0 w-0 overflow-hidden">
            <div ref={pinsMeasureRef} className="absolute left-0 top-0 flex w-max items-center gap-1">
              {pins.map((cmd) => (
                <span key={cmd.id} className={PIN_CHIP_CLASS}>
                  {cmd.emoji ? <span className="shrink-0">{cmd.emoji}</span> : null}
                  <span className="truncate">{cmd.label}</span>
                </span>
              ))}
            </div>
          </div>
          {pinsFit && (
            <div data-quick-pins="" className="flex items-center gap-1">
              {pins.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => void runQuickCommand(cmd, sendByDefault)}
                  disabled={runningId === cmd.id}
                  title={isPromptCommand(cmd) ? `AI: ${cmd.prompt}` : cmd.body}
                  className={`${PIN_CHIP_CLASS} transition hover:bg-muted active:scale-95 disabled:opacity-60`}
                >
                  {cmd.emoji ? <span className="shrink-0">{cmd.emoji}</span> : null}
                  <span className="truncate">{cmd.label}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {open &&
        createPortal(
          <>
            {!isDesktop && <div className="fixed inset-0 z-[149] bg-black/40" aria-hidden />}
            {panel}
          </>,
          document.body,
        )}

      {managerOpen &&
        createPortal(
          <QuickCommandManager
            commands={commands}
            settings={settings}
            onClose={() => setManagerOpen(false)}
            onCreate={create}
            onUpdate={update}
            onDelete={remove}
            onSaveSettings={saveSettings}
          />,
          document.body,
        )}
    </>
  );
}

export default memo(QuickCommandsControl);

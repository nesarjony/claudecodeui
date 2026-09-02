import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';

import {
  detectAgentState,
  useQuickCommands,
  type QuickCommand,
  type QuickCommandInput,
  type QuickCommandSettings,
  type TriggerState,
} from '@/modules/chat/hooks/useQuickCommands';
import { useQuickCommandsVisible } from '@/modules/chat/hooks/useQuickCommandsVisible';

type MinimalMsg = {
  type?: string;
  content?: string;
  displayText?: string;
  [k: string]: unknown;
};

type QuickCommandBarProps = {
  setInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  chatMessages: MinimalMsg[];
  isProcessing: boolean;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};

const TRIGGER_OPTIONS: { value: '' | TriggerState; label: string }[] = [
  { value: '', label: 'Always show' },
  { value: 'done', label: 'When agent finishes' },
  { value: 'error', label: 'When agent errors' },
  { value: 'question', label: 'When agent asks' },
  { value: 'idle', label: 'When agent stalls' },
];

const MODEL_OPTIONS: { value: QuickCommandSettings['model']; label: string }[] = [
  { value: 'haiku', label: 'Haiku — MiniMax (cheap, metered)' },
  { value: 'sonnet', label: 'Sonnet — Claude plan' },
  { value: 'opus', label: 'Opus — Claude plan (best)' },
];


export default function QuickCommandBar({
  setInput,
  textareaRef,
  chatMessages,
  isProcessing,
  onSubmit,
}: QuickCommandBarProps) {
  const { commands, settings, create, update, remove, saveSettings, suggestLlm, runCommand } =
    useQuickCommands();
  const [managerOpen, setManagerOpen] = useState(false);
  const [suggestedIds, setSuggestedIds] = useState<number[]>([]);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [barVisible, setBarVisible] = useQuickCommandsVisible();
  const prevProcessing = useRef(isProcessing);

  const lastAssistantText = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m?.type === 'assistant') {
        const s =
          (typeof m.displayText === 'string' && m.displayText) ||
          (typeof m.content === 'string' && m.content) ||
          '';
        if (s && s.trim()) return s;
      }
    }
    return '';
  }, [chatMessages]);

  // Free heuristic: runs whenever a turn is settled. Zero model calls.
  useEffect(() => {
    if (settings.mode === 'off') {
      setSuggestedIds([]);
      return;
    }
    if (isProcessing) return;
    const state = detectAgentState(lastAssistantText);
    const heur = state
      ? commands.filter((c) => c.trigger_state === state).map((c) => c.id)
      : [];
    setSuggestedIds(heur);
  }, [isProcessing, settings.mode, lastAssistantText, commands]);

  // Opt-in LLM refine: only on the turn-complete edge, only when mode==='llm'.
  useEffect(() => {
    const was = prevProcessing.current;
    prevProcessing.current = isProcessing;
    if (was && !isProcessing && settings.mode === 'llm' && lastAssistantText.trim()) {
      void suggestLlm(lastAssistantText).then((ids) => {
        if (ids.length) setSuggestedIds(ids);
      });
    }
  }, [isProcessing, settings.mode, lastAssistantText, suggestLlm]);

  const suggestedSet = useMemo(() => new Set(suggestedIds), [suggestedIds]);
  const ordered = useMemo(() => {
    if (!suggestedIds.length) return commands;
    const rank = new Map(suggestedIds.map((id, i) => [id, i]));
    return [...commands].sort((a, b) => {
      const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Infinity;
      const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.sort_order - b.sort_order;
    });
  }, [commands, suggestedIds]);

  // --- Horizontal scroll UX for the chip row -------------------------------
  // Desktop mice can't scroll a hidden-scrollbar row (the wheel scrolls the page
  // vertically), so the row looked "stuck". We add: vertical-wheel → horizontal
  // scroll, arrow buttons that appear only when there's overflow that way, and
  // edge fades. Touch devices keep native swipe; the arrows are a bonus there.
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, startLeft: 0 });
  const suppressClickRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollAffordance = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollAffordance();
    const ro = new ResizeObserver(updateScrollAffordance);
    ro.observe(el);
    // Repurpose vertical wheel to horizontal scroll (only when this row actually
    // overflows and the gesture is vertical — leaves native trackpad swipe alone).
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
      updateScrollAffordance();
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    // Click-and-drag ("swipe") to scroll the chip row -- essential in narrow
    // panes (e.g. the 8-up split) where the row is too small to reach the arrows
    // and a mouse cannot grab a hidden-scrollbar row. Touch keeps its native
    // swipe (pointerType 'touch' is ignored); a drag past a few px swallows the
    // trailing click so it never fires a chip.
    const drag = dragRef.current;
    const onPointerDown = (event: PointerEvent) => {
      suppressClickRef.current = false;
      if (event.pointerType === 'touch') return;
      if (el.scrollWidth <= el.clientWidth) return;
      drag.active = true;
      drag.moved = false;
      drag.startX = event.clientX;
      drag.startLeft = el.scrollLeft;
      el.style.scrollBehavior = 'auto';
      try { el.setPointerCapture(event.pointerId); } catch { /* older engines */ }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag.active) return;
      const dx = event.clientX - drag.startX;
      if (Math.abs(dx) > 4) drag.moved = true;
      el.scrollLeft = drag.startLeft - dx;
      updateScrollAffordance();
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!drag.active) return;
      drag.active = false;
      el.style.scrollBehavior = '';
      try { el.releasePointerCapture(event.pointerId); } catch { /* older engines */ }
      if (drag.moved) suppressClickRef.current = true;
    };
    const onClickCapture = (event: MouseEvent) => {
      if (suppressClickRef.current) {
        event.stopPropagation();
        event.preventDefault();
        suppressClickRef.current = false;
      }
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    el.addEventListener('pointerleave', onPointerEnd);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      el.removeEventListener('pointerleave', onPointerEnd);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, [updateScrollAffordance, commands, ordered]);

  const scrollChipsBy = useCallback((direction: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.7), behavior: 'smooth' });
  }, []);

  const submitDeferred = () => {
    if (settings.send_mode === 'direct' && onSubmit) {
      // Defer so React commits setInput and the composer mirrors the new text
      // into its inputValueRef before we dispatch submit (same trick the
      // slash-command executor and voice "stop & send" use).
      setTimeout(
        () => onSubmit({ preventDefault: () => undefined } as unknown as React.FormEvent<HTMLFormElement>),
        0
      );
    } else {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const insert = async (cmd: QuickCommand) => {
    // Auto-collapse the bar once a command is used, so it stops eating composer
    // height every turn (a small "Commands" pill brings it back).
    setBarVisible(false);
    // A command with a custom prompt runs the LLM against the agent's last
    // message and drops the generated text into the composer.
    if (cmd.prompt && cmd.prompt.trim()) {
      if (runningId != null) return;
      setRunningId(cmd.id);
      const text = await runCommand(cmd.id, lastAssistantText);
      setRunningId(null);
      if (text != null && text.trim()) {
        setInput(text);
        submitDeferred();
      } else {
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      return;
    }
    setInput((prev) => {
      if (cmd.body.includes('{input}')) {
        return cmd.body.replace(/\{input\}/g, prev.trim());
      }
      return prev.trim() ? `${prev.replace(/\s+$/, '')}\n${cmd.body}` : cmd.body;
    });
    submitDeferred();
  };

  const gear = (
    <button
      type="button"
      onClick={() => setManagerOpen(true)}
      title="Manage quick commands"
      className="flex-shrink-0 rounded-full border border-border/60 bg-muted/40 p-1.5 text-muted-foreground transition hover:bg-muted"
    >
      <Settings2 className="h-3.5 w-3.5" />
    </button>
  );

  const manager = managerOpen && (
    <QuickCommandManager
      commands={commands}
      settings={settings}
      onClose={() => setManagerOpen(false)}
      onCreate={create}
      onUpdate={update}
      onDelete={remove}
      onSaveSettings={saveSettings}
    />
  );

  // While the agent is generating, cloudcli renders its activity/queue panel in
  // the `absolute bottom-full` slot directly above the composer — the same space
  // this bar occupies, which collides on mobile (chips peek out as empty pills).
  // Yield the space while processing; the bar returns when the turn settles (and
  // Smart Suggest then surfaces the right chip). Keep the manager mountable.
  if (isProcessing) {
    return managerOpen ? (
      <div className="mx-auto mb-2 max-w-[54.25rem] px-2 sm:px-0">{manager}</div>
    ) : null;
  }

  if (commands.length === 0 && !managerOpen) {
    return (
      <div className="mx-auto mb-2 flex max-w-[54.25rem] justify-end px-2 sm:px-0">
        <button
          type="button"
          onClick={() => setManagerOpen(true)}
          className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" /> Quick commands
        </button>
      </div>
    );
  }

  // Hidden: render nothing in the flow (zero height) so the flex-1 messages pane
  // expands into this space — hiding gives the room to the chat, which is the
  // point. The composer toolbar's toggle brings it back (and re-opening the
  // manager from there works even while hidden).
  if (!barVisible) {
    return managerOpen ? (
      <div className="mx-auto mb-2 max-w-[54.25rem] px-2 sm:px-0">{manager}</div>
    ) : null;
  }

  const renderChip = (cmd: QuickCommand) => {
    const suggested = suggestedSet.has(cmd.id);
    const isPrompt = Boolean(cmd.prompt && cmd.prompt.trim());
    const running = runningId === cmd.id;
    return (
      <button
        key={cmd.id}
        type="button"
        onClick={() => insert(cmd)}
        disabled={running}
        title={isPrompt ? `AI: ${cmd.prompt}` : cmd.body}
        className={
          'flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-medium transition active:scale-95 disabled:opacity-60 sm:py-1.5 ' +
          (suggested
            ? 'border-primary/50 bg-primary/10 text-foreground ring-1 ring-primary/40 shadow-[0_0_0_3px_rgba(99,102,241,0.12)]'
            : 'border-border/60 bg-muted/40 text-foreground hover:bg-muted')
        }
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
        ) : suggested ? (
          <Sparkles className="h-3 w-3 text-primary" />
        ) : isPrompt ? (
          <Wand2 className="h-3 w-3 text-primary/80" />
        ) : null}
        {cmd.emoji ? <span>{cmd.emoji}</span> : null}
        {cmd.label}
      </button>
    );
  };

  // One full-width scroll row so nothing gets squeezed on mobile. Pinned chips
  // render first (stable order) so they're visible without scrolling; the rest
  // follow (suggestion-sorted). Everything scrolls together.
  const pinnedChips = commands
    .filter((c) => c.pinned)
    .sort((a, b) => a.sort_order - b.sort_order);
  const scrollChips = ordered.filter((c) => !c.pinned);
  const rowChips = [...pinnedChips, ...scrollChips];

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem] px-2 sm:px-0">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          {/* Left: fade + arrow, shown only when scrolled away from the start */}
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-12 items-center bg-gradient-to-r from-background via-background/90 to-transparent">
              <button
                type="button"
                onClick={() => scrollChipsBy(-1)}
                aria-label="Scroll commands left"
                className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition hover:text-foreground active:scale-95"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>
          )}

          <div
            ref={scrollRef}
            onScroll={updateScrollAffordance}
            className="flex cursor-grab select-none items-center gap-2 overflow-x-auto scroll-smooth pb-1 active:cursor-grabbing [-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {rowChips.map(renderChip)}
          </div>

          {/* Right: fade + arrow, shown only when more chips lie off-screen */}
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background/90 to-transparent">
              <button
                type="button"
                onClick={() => scrollChipsBy(1)}
                aria-label="Scroll commands right"
                className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition hover:text-foreground active:scale-95"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setBarVisible(false)}
          title="Hide quick commands"
          aria-label="Hide quick commands"
          className="flex-shrink-0 rounded-full border border-border/60 bg-muted/40 p-1.5 text-muted-foreground transition hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {gear}
      </div>
      {manager}
    </div>
  );
}

type ManagerProps = {
  commands: QuickCommand[];
  settings: QuickCommandSettings;
  onClose: () => void;
  onCreate: (input: QuickCommandInput) => Promise<boolean>;
  onUpdate: (id: number, input: Partial<QuickCommandInput>) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
  onSaveSettings: (next: Partial<QuickCommandSettings>) => Promise<boolean>;
};

function QuickCommandManager({
  commands,
  settings,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onSaveSettings,
}: ManagerProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [emoji, setEmoji] = useState('');
  const [body, setBody] = useState('');
  const [prompt, setPrompt] = useState('');
  const [trigger, setTrigger] = useState<'' | TriggerState>('');
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setLabel('');
    setEmoji('');
    setBody('');
    setPrompt('');
    setTrigger('');
  };

  const startEdit = (cmd: QuickCommand) => {
    setEditingId(cmd.id);
    setLabel(cmd.label);
    setEmoji(cmd.emoji || '');
    setBody(cmd.body);
    setPrompt(cmd.prompt || '');
    setTrigger((cmd.trigger_state as TriggerState) || '');
  };

  const canSave = Boolean(label.trim() && (body.trim() || prompt.trim()));

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const payload = {
      label: label.trim(),
      body,
      emoji: emoji.trim() || null,
      trigger_state: (trigger || null) as TriggerState | null,
      prompt: prompt.trim() || null,
    };
    const ok =
      editingId != null ? await onUpdate(editingId, payload) : await onCreate(payload);
    setSaving(false);
    if (ok) resetForm();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Quick commands</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Command list */}
          <div className="space-y-2">
            {commands.map((cmd) => (
              <div
                key={cmd.id}
                className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/30 p-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-xs font-medium">
                    <span>
                      {cmd.emoji ? `${cmd.emoji} ` : ''}
                      {cmd.label}
                    </span>
                    {cmd.prompt && cmd.prompt.trim() ? (
                      <Wand2 className="h-3 w-3 flex-shrink-0 text-primary/80" />
                    ) : null}
                    {cmd.trigger_state ? (
                      <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-primary">
                        {cmd.trigger_state}
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {cmd.prompt && cmd.prompt.trim() ? cmd.prompt : cmd.body}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onUpdate(cmd.id, { pinned: cmd.pinned ? 0 : 1 })}
                  title={cmd.pinned ? 'Unpin' : 'Pin (fixed position)'}
                  className={
                    'rounded-md p-1 ' +
                    (cmd.pinned ? 'text-primary' : 'text-muted-foreground hover:bg-muted')
                  }
                >
                  <Pin className={'h-3.5 w-3.5 ' + (cmd.pinned ? 'fill-current' : '')} />
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(cmd)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(cmd.id)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {commands.length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">
                No quick commands yet. Add one below.
              </p>
            )}
          </div>

          {/* Add / edit form */}
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {editingId != null ? 'Edit command' : 'Add command'}
            </div>
            <div className="flex gap-2">
              <input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="🚀"
                maxLength={4}
                className="w-14 rounded-lg border border-border bg-background px-2 py-1.5 text-center text-sm"
              />
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. Cross-check)"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Message text… use {input} to wrap what you already typed"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
            <div className="space-y-1 rounded-lg border border-primary/20 bg-primary/[0.04] p-2">
              <div className="flex items-center gap-1 text-[11px] font-medium text-primary/90">
                <Wand2 className="h-3 w-3" /> Custom AI prompt (optional)
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder="e.g. Summarize the agent's last message in 3 bullets"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
              />
              <p className="text-[10px] leading-snug text-muted-foreground">
                If set, tapping runs this prompt against the agent's last message via
                native claude -p (~7s, uses the AI model below) and drops the result into
                the composer. Leave empty for a plain text command.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Suggest</span>
              <select
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as '' | TriggerState)}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              {editingId != null && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={saving || !canSave}
                onClick={handleSave}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {editingId != null ? 'Save' : 'Add'}
              </button>
            </div>
          </div>

          {/* Tap action */}
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              When I tap a command
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { v: 'insert', l: 'Insert to edit' },
                  { v: 'direct', l: 'Send now' },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => onSaveSettings({ send_mode: o.v })}
                  className={
                    'rounded-lg border px-2 py-1.5 text-xs font-medium transition ' +
                    (settings.send_mode === o.v
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background text-muted-foreground hover:bg-muted')
                  }
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              {settings.send_mode === 'insert'
                ? 'Fills the box so you can edit, then you hit send.'
                : 'Sends the command the instant you tap — true one-tap for the walking pad.'}
            </p>
          </div>

          {/* Smart Suggest settings */}
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" /> Smart Suggest
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { v: 'off', l: 'Off' },
                  { v: 'heuristic', l: 'Smart' },
                  { v: 'llm', l: 'Smart+' },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => onSaveSettings({ mode: o.v })}
                  className={
                    'rounded-lg border px-2 py-1.5 text-xs font-medium transition ' +
                    (settings.mode === o.v
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background text-muted-foreground hover:bg-muted')
                  }
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              {settings.mode === 'off' && 'No suggestions.'}
              {settings.mode === 'heuristic' &&
                'Free & instant — highlights the right chip from the agent’s last message. No model call.'}
              {settings.mode === 'llm' &&
                'Uses native claude -p to rank chips each turn — adds ~7s and spends the chosen model’s wallet.'}
            </p>
            <div className="flex items-center gap-2 border-t border-border/50 pt-2">
              <span className="text-[11px] text-muted-foreground">AI model</span>
              <select
                value={settings.model}
                onChange={(e) =>
                  onSaveSettings({ model: e.target.value as QuickCommandSettings['model'] })
                }
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              >
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Used by Smart+ and by any command with a custom AI prompt.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

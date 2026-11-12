import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter } from 'lucide-react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';

// Synced per user on the server, which also applies them when listing sessions.
const PREF_SHOW_AUTOMATED = 'sidebar.showAutomatedSessions';
const PREF_SHOW_HIDDEN = 'sidebar.showHiddenSessions';
const PREF_HIDDEN_IDS = 'sidebar.hiddenSessionIds';

type SessionVisibility = {
  showAutomated: boolean;
  showHidden: boolean;
  hiddenIds: ReadonlySet<string>;
  setShowAutomated: (show: boolean) => Promise<void>;
  setShowHidden: (show: boolean) => Promise<void>;
  hide: (sessionIds: string[]) => Promise<void>;
  unhide: (sessionIds: string[]) => Promise<void>;
};

const noopAsync = async () => undefined;
const SessionVisibilityContext = createContext<SessionVisibility>({
  showAutomated: false,
  showHidden: false,
  hiddenIds: new Set(),
  setShowAutomated: noopAsync,
  setShowHidden: noopAsync,
  hide: noopAsync,
  unhide: noopAsync,
});

/** Which sessions the sidebar lists, and the actions that change it. */
export function useSessionVisibility(): SessionVisibility {
  return useContext(SessionVisibilityContext);
}

type SessionVisibilityProviderProps = {
  /** Reloads the session lists; the server filters them by these preferences. */
  onChanged: () => Promise<void> | void;
  children: ReactNode;
};

export function SessionVisibilityProvider({ onChanged, children }: SessionVisibilityProviderProps) {
  const [showAutomated, setShowAutomatedState] = useState(false);
  const [showHidden, setShowHiddenState] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.user.preferences();
        if (!response.ok || cancelled) return;
        const { preferences } = (await response.json()) as { preferences?: Record<string, unknown> };
        if (!preferences || cancelled) return;
        setShowAutomatedState(preferences[PREF_SHOW_AUTOMATED] === true);
        setShowHiddenState(preferences[PREF_SHOW_HIDDEN] === true);
        const ids = preferences[PREF_HIDDEN_IDS];
        setHiddenIds(new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []));
      } catch {
        // Defaults stand; the server still filters with what it has stored.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (updates: Record<string, unknown>) => {
      try {
        await api.user.savePreferences(updates);
      } finally {
        await onChanged();
      }
    },
    [onChanged],
  );

  const setShowAutomated = useCallback(
    async (show: boolean) => {
      setShowAutomatedState(show);
      await save({ [PREF_SHOW_AUTOMATED]: show });
    },
    [save],
  );

  const setShowHidden = useCallback(
    async (show: boolean) => {
      setShowHiddenState(show);
      await save({ [PREF_SHOW_HIDDEN]: show });
    },
    [save],
  );

  const hiddenRef = useRef(hiddenIds);
  hiddenRef.current = hiddenIds;

  const hide = useCallback(
    async (sessionIds: string[]) => {
      const next = new Set(hiddenRef.current);
      sessionIds.forEach((id) => next.add(id));
      setHiddenIds(next);
      await save({ [PREF_HIDDEN_IDS]: [...next] });
    },
    [save],
  );

  const unhide = useCallback(
    async (sessionIds: string[]) => {
      const next = new Set(hiddenRef.current);
      sessionIds.forEach((id) => next.delete(id));
      setHiddenIds(next);
      await save({ [PREF_HIDDEN_IDS]: [...next] });
    },
    [save],
  );

  const value = useMemo<SessionVisibility>(
    () => ({ showAutomated, showHidden, hiddenIds, setShowAutomated, setShowHidden, hide, unhide }),
    [showAutomated, showHidden, hiddenIds, setShowAutomated, setShowHidden, hide, unhide],
  );

  return <SessionVisibilityContext.Provider value={value}>{children}</SessionVisibilityContext.Provider>;
}

function Switch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
        )}
      />
    </span>
  );
}

const MENU_WIDTH_PX = 264;

/** Header button with the sidebar's visibility switches. */
export function SessionVisibilityMenu({ variant }: { variant: 'desktop' | 'mobile' }) {
  const visibility = useSessionVisibility();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const filtering = !visibility.showAutomated || !visibility.showHidden;
  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH_PX - 8)),
      });
    }
    setOpen((value) => !value);
  };

  const rows: Array<{ key: string; label: string; detail: string; checked: boolean; onToggle: () => void }> = [
    {
      key: 'automated',
      label: 'Show automated runs',
      detail: 'Sessions started by claude -p or scripts, not opened as chats.',
      checked: visibility.showAutomated,
      onToggle: () => void visibility.setShowAutomated(!visibility.showAutomated),
    },
    {
      key: 'hidden',
      label: `Show hidden sessions${visibility.hiddenIds.size ? ` (${visibility.hiddenIds.size})` : ''}`,
      detail: 'Sessions you hid from the list.',
      checked: visibility.showHidden,
      onToggle: () => void visibility.setShowHidden(!visibility.showHidden),
    },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Which sessions to show"
        title="Which sessions to show"
        className={cn(
          'relative flex items-center justify-center rounded-lg transition-colors',
          variant === 'desktop' ? 'h-7 w-7 hover:bg-accent/80' : 'h-8 w-8 bg-muted/50 active:scale-95',
          open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <ListFilter className={variant === 'desktop' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        {filtering && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Which sessions to show"
            style={{ top: anchor.top, left: anchor.left, width: MENU_WIDTH_PX }}
            className="fixed z-[170] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
          >
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={row.checked}
                onClick={row.onToggle}
                className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground">{row.label}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{row.detail}</span>
                </span>
                <Switch checked={row.checked} />
              </button>
            ))}
            {visibility.hiddenIds.size > 0 && (
              <button
                type="button"
                onClick={() => void visibility.unhide([...visibility.hiddenIds])}
                className="mt-1 w-full rounded-lg px-2.5 py-2 text-left text-xs font-medium text-primary transition hover:bg-muted"
              >
                Unhide all {visibility.hiddenIds.size} sessions
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

type HiddenSessionsNoteProps = { hiddenAutomated: number; hiddenByUser: number };

/** Under a project's sessions: how many are filtered out, with a one-tap reveal. */
export function HiddenSessionsNote({ hiddenAutomated, hiddenByUser }: HiddenSessionsNoteProps) {
  const visibility = useSessionVisibility();
  if (hiddenAutomated <= 0 && hiddenByUser <= 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-1 pt-1 text-[11px] text-muted-foreground">
      {hiddenAutomated > 0 && (
        <button type="button" onClick={() => void visibility.setShowAutomated(true)} className="hover:text-foreground">
          {hiddenAutomated} automated run{hiddenAutomated === 1 ? '' : 's'} hidden · <span className="text-primary">Show</span>
        </button>
      )}
      {hiddenByUser > 0 && (
        <button type="button" onClick={() => void visibility.setShowHidden(true)} className="hover:text-foreground">
          {hiddenByUser} hidden · <span className="text-primary">Show</span>
        </button>
      )}
    </div>
  );
}

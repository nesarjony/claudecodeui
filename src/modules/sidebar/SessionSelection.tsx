import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, CheckSquare, Eye, EyeOff, Loader2, Trash2, X } from 'lucide-react';

import { api } from '@/shared/api';
import { useSessionVisibility } from '@/modules/sidebar/SessionVisibility';
import { cn } from '@/shared/utils';

type SessionSelection = {
  active: boolean;
  selected: ReadonlySet<string>;
  busy: boolean;
  start: () => void;
  cancel: () => void;
  toggle: (sessionId: string) => void;
  selectMany: (sessionIds: string[]) => void;
  deselectMany: (sessionIds: string[]) => void;
  archiveSelected: () => Promise<void>;
  deleteSelected: () => Promise<void>;
};

const noop = () => undefined;
const SessionSelectionContext = createContext<SessionSelection>({
  active: false,
  selected: new Set(),
  busy: false,
  start: noop,
  cancel: noop,
  toggle: noop,
  selectMany: noop,
  deselectMany: noop,
  archiveSelected: async () => undefined,
  deleteSelected: async () => undefined,
});

/** Read by sidebar rows, header and footer to take part in multi-select. */
export function useSessionSelection(): SessionSelection {
  return useContext(SessionSelectionContext);
}

type SessionSelectionProviderProps = {
  /** Refreshes the session lists after sessions were archived or deleted. */
  onChanged: () => Promise<void> | void;
  children: ReactNode;
};

/** Holds the sidebar's multi-select state and runs the bulk archive / delete. */
export function SessionSelectionProvider({ onChanged, children }: SessionSelectionProviderProps) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const cancel = useCallback(() => {
    setActive(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((sessionId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const selectMany = useCallback((sessionIds: string[]) => {
    setSelected((previous) => new Set([...previous, ...sessionIds]));
  }, []);

  const deselectMany = useCallback((sessionIds: string[]) => {
    setSelected((previous) => {
      const next = new Set(previous);
      sessionIds.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const removeSelected = useCallback(
    async (hardDelete: boolean) => {
      if (selected.size === 0) return;
      setBusy(true);
      let failed = 0;
      for (const sessionId of selected) {
        try {
          const response = await api.deleteSession(sessionId, hardDelete);
          if (!response.ok) failed += 1;
        } catch {
          failed += 1;
        }
      }
      setBusy(false);
      cancel();
      await onChanged();
      if (failed > 0) {
        window.alert(`${failed} of the selected sessions could not be ${hardDelete ? 'deleted' : 'archived'}.`);
      }
    },
    [selected, cancel, onChanged],
  );

  const archiveSelected = useCallback(() => removeSelected(false), [removeSelected]);
  const deleteSelected = useCallback(async () => {
    const count = selected.size;
    const confirmed = window.confirm(
      `Permanently delete ${count} session${count === 1 ? '' : 's'}? Their transcripts are removed and this cannot be undone.`,
    );
    if (confirmed) await removeSelected(true);
  }, [selected, removeSelected]);

  const value = useMemo<SessionSelection>(
    () => ({
      active,
      selected,
      busy,
      start: () => setActive(true),
      cancel,
      toggle,
      selectMany,
      deselectMany,
      archiveSelected,
      deleteSelected,
    }),
    [active, selected, busy, cancel, toggle, selectMany, deselectMany, archiveSelected, deleteSelected],
  );

  return <SessionSelectionContext.Provider value={value}>{children}</SessionSelectionContext.Provider>;
}

/** Header button that turns multi-select on and off. */
export function SessionSelectToggle({ variant }: { variant: 'desktop' | 'mobile' }) {
  const selection = useSessionSelection();
  const label = selection.active ? 'Stop selecting' : 'Select sessions';
  return (
    <button
      type="button"
      onClick={selection.active ? selection.cancel : selection.start}
      aria-pressed={selection.active}
      aria-label={label}
      title={label}
      className={cn(
        'flex items-center justify-center rounded-lg transition-colors',
        variant === 'desktop' ? 'h-7 w-7 hover:bg-accent/80' : 'h-8 w-8 bg-muted/50 active:scale-95',
        selection.active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <CheckSquare className={variant === 'desktop' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
    </button>
  );
}

/** Replaces the sidebar footer while selecting: count plus the bulk actions. */
// Session rows render this attribute while selecting, so "Select all" can take
// every session currently listed (loaded pages of expanded projects).
export const SELECTABLE_SESSION_ATTRIBUTE = 'data-select-session-id';

function listedSessionIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SELECTABLE_SESSION_ATTRIBUTE}]`)]
    .map((element) => element.getAttribute(SELECTABLE_SESSION_ATTRIBUTE) ?? '')
    .filter(Boolean);
}

export function SessionSelectionBar() {
  const selection = useSessionSelection();
  const visibility = useSessionVisibility();
  const count = selection.selected.size;
  const selectedIds = [...selection.selected];
  const allHidden = count > 0 && selectedIds.every((id) => visibility.hiddenIds.has(id));
  const listed = listedSessionIds();
  const allListedSelected = listed.length > 0 && listed.every((id) => selection.selected.has(id));
  return (
    <div className="flex-shrink-0 border-t border-border/60 bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="text-sm font-medium text-foreground">
          {count === 0 ? 'Tap sessions to select' : `${count} selected`}
        </span>
        <button
          type="button"
          onClick={() => {
            const ids = listedSessionIds();
            if (ids.length > 0 && ids.every((id) => selection.selected.has(id))) selection.deselectMany(ids);
            else selection.selectMany(ids);
          }}
          className="ml-auto rounded-md px-2 py-1 text-xs font-medium text-primary transition hover:bg-muted"
        >
          {allListedSelected ? 'Deselect all' : 'Select all'}
        </button>
        <button
          type="button"
          onClick={selection.cancel}
          aria-label="Cancel selection"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={count === 0 || selection.busy}
          onClick={async () => {
            if (allHidden) await visibility.unhide(selectedIds);
            else await visibility.hide(selectedIds);
            selection.cancel();
          }}
          className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border/70 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-40 md:h-9"
        >
          {allHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />} {allHidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          type="button"
          disabled={count === 0 || selection.busy}
          onClick={() => void selection.archiveSelected()}
          className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border/70 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-40 md:h-9"
        >
          {selection.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />} Archive
        </button>
        <button
          type="button"
          disabled={count === 0 || selection.busy}
          onClick={() => void selection.deleteSelected()}
          className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-red-500/90 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-40 md:h-9"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>
    </div>
  );
}

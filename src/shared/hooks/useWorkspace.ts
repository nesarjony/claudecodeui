import { useCallback, useState } from 'react';

// Native multi-pane workspace: a grid layout (1..4) where each pane shows a
// different session via its own <MainContent>. Persisted to localStorage.

export type WorkspacePane = {
  id: string;
  sessionId: string | null;
  // Set when the pane hosts a brand-new (not-yet-created) session for a project:
  // it renders the new-session composer. Cleared once the composer creates a
  // real session and `sessionId` is assigned.
  newProjectId?: string | null;
};

type WorkspaceState = {
  layout: number;
  panes: WorkspacePane[];
  activePaneId: string;
};

const STORAGE_KEY = 'web-workspace';
const VALID_LAYOUTS = new Set([1, 2, 3, 4, 6, 8]);

// Monotonic id counter. MUST always sit at/above the highest suffix currently
// in use — otherwise `nextPaneId()` can regenerate an id that already exists
// (e.g. after shrinking then re-growing the layout), producing DUPLICATE pane
// ids. Duplicates are toxic: `assignPane(id, …)` / focus match every pane with
// that id, so one selection fills/activates several panes at once, and React's
// keyed reconciliation collapses them — the classic "two panes run the same
// session" bug. Seed it from restored state, never from the pane COUNT.
let paneSeq = 0;
function paneIdSuffix(id: string): number {
  const m = /^pane-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
function nextPaneId(): string {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

// The web app is also loaded inside the CloudCLI desktop app's panes (same
// origin → shared localStorage). Those loads carry `?solo`, which forces the
// single-pane view so the desktop grid never nests a web grid inside itself.
// Captured ONCE at module load: this app is a SPA, and React Router drops the
// query param on internal navigation — reading it per-call would flip the guard
// off after the first route change and reveal the nested grid.
const SOLO: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).has('solo');
  } catch {
    return false;
  }
})();

function initialState(): WorkspaceState {
  if (SOLO) {
    const only = { id: nextPaneId(), sessionId: null };
    return { layout: 1, panes: [only], activePaneId: only.id };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceState;
      if (
        VALID_LAYOUTS.has(parsed.layout) &&
        Array.isArray(parsed.panes) &&
        parsed.panes.length === parsed.layout
      ) {
        // Seed the counter above the highest EXISTING suffix (not the count) so
        // future ids never collide with restored ones.
        paneSeq = parsed.panes.reduce((max, p) => Math.max(max, paneIdSuffix(p.id)), 0);
        // Self-heal any already-corrupted state: a duplicate/missing id gets a
        // fresh unique id. Fixes localStorage saved by the old buggy counter
        // without forcing the user to clear anything.
        const seen = new Set<string>();
        const panes = parsed.panes.map((p) => {
          if (!p.id || seen.has(p.id)) {
            return { ...p, id: nextPaneId() };
          }
          seen.add(p.id);
          return p;
        });
        const activePaneId = panes.some((p) => p.id === parsed.activePaneId)
          ? parsed.activePaneId
          : panes[0].id;
        const healed = { layout: parsed.layout, panes, activePaneId };
        // Write the repair back so storage stops carrying the corruption
        // (otherwise it re-heals identically on every load, which is harmless
        // but leaves the bad value on disk). No-op when nothing changed.
        const changed =
          activePaneId !== parsed.activePaneId ||
          panes.some((p, i) => p.id !== parsed.panes[i]?.id);
        return changed ? persist(healed) : healed;
      }
    }
  } catch {
    // ignore corrupt storage
  }
  const first = { id: nextPaneId(), sessionId: null };
  return { layout: 1, panes: [first], activePaneId: first.id };
}

function persist(state: WorkspaceState): WorkspaceState {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private-mode failures
  }
  return state;
}

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>(initialState);

  const setLayout = useCallback((n: number) => {
    if (SOLO || !VALID_LAYOUTS.has(n)) return;
    setState((prev) => {
      let panes = prev.panes.slice();
      while (panes.length < n) panes.push({ id: nextPaneId(), sessionId: null });
      if (panes.length > n) panes = panes.slice(0, n);
      const activePaneId = panes.some((p) => p.id === prev.activePaneId)
        ? prev.activePaneId
        : panes[0].id;
      return persist({ layout: n, panes, activePaneId });
    });
  }, []);

  const focusPane = useCallback((id: string) => {
    setState((prev) => (prev.activePaneId === id ? prev : { ...prev, activePaneId: id }));
  }, []);

  const assignPane = useCallback((paneId: string, sessionId: string | null) => {
    setState((prev) =>
      persist({
        ...prev,
        activePaneId: paneId,
        // A real session supersedes any pending new-session state on this pane.
        panes: prev.panes.map((p) => (p.id === paneId ? { ...p, sessionId, newProjectId: null } : p)),
      }),
    );
  }, []);

  // Put a session into the currently-focused pane (sidebar click in grid mode).
  const assignActive = useCallback((sessionId: string | null) => {
    setState((prev) =>
      persist({
        ...prev,
        panes: prev.panes.map((p) =>
          p.id === prev.activePaneId ? { ...p, sessionId, newProjectId: null } : p,
        ),
      }),
    );
  }, []);

  // Open a brand-new session for `projectId` in the currently-focused pane
  // (sidebar "New Session" click in grid mode). The pane renders the composer;
  // once the first message creates a session, assignPane swaps in its id.
  const assignNewSessionActive = useCallback((projectId: string) => {
    setState((prev) =>
      persist({
        ...prev,
        panes: prev.panes.map((p) =>
          p.id === prev.activePaneId ? { ...p, sessionId: null, newProjectId: projectId } : p,
        ),
      }),
    );
  }, []);

  const clearPane = useCallback((id: string) => {
    setState((prev) =>
      persist({
        ...prev,
        panes: prev.panes.map((p) => (p.id === id ? { ...p, sessionId: null, newProjectId: null } : p)),
      }),
    );
  }, []);

  const expandPane = useCallback((id: string) => {
    setState((prev) => {
      const pane = prev.panes.find((p) => p.id === id) || prev.panes[0];
      return persist({ layout: 1, panes: [pane], activePaneId: pane.id });
    });
  }, []);

  return {
    layout: state.layout,
    panes: state.panes,
    activePaneId: state.activePaneId,
    // True when loaded inside a desktop pane (`?solo`) — hide the web switcher.
    isSolo: SOLO,
    setLayout,
    focusPane,
    assignPane,
    assignActive,
    assignNewSessionActive,
    clearPane,
    expandPane,
  };
}

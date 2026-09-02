import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '@/shared/api';

export type TriggerState = 'done' | 'error' | 'question' | 'idle';

export type QuickCommand = {
  id: number;
  label: string;
  body: string;
  emoji: string | null;
  trigger_state: TriggerState | null;
  pinned: number;
  prompt: string | null;
  sort_order: number;
};

export type QuickCommandSettings = {
  mode: 'off' | 'heuristic' | 'llm';
  model: 'haiku' | 'sonnet' | 'opus';
  send_mode: 'insert' | 'direct';
};

export type QuickCommandInput = {
  label: string;
  body: string;
  emoji?: string | null;
  trigger_state?: TriggerState | null;
  pinned?: number;
  prompt?: string | null;
};

const DEFAULT_SETTINGS: QuickCommandSettings = {
  mode: 'heuristic',
  model: 'haiku',
  send_mode: 'insert',
};

// ---------------------------------------------------------------------------
// Shared module-level cache. Quick commands are the SAME for every session and
// every split-view pane, but the hook used to hold them in per-instance state
// and fetch on every mount — so each pane / session-switch fired its own
// `/api/quick-commands` request and the bar only appeared after that request
// resolved (with N panes: N redundant fetches, chips popping in late or "not in
// all sessions"). Now the data is fetched ONCE, cached here, and shared: any
// new pane/session paints the chips instantly, and a mutation in one pane
// notifies all the others.
// ---------------------------------------------------------------------------
type QuickCommandsSnapshot = {
  commands: QuickCommand[];
  settings: QuickCommandSettings;
  loading: boolean;
};

let cache: QuickCommandsSnapshot = {
  commands: [],
  settings: DEFAULT_SETTINGS,
  loading: false,
};
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(snap: QuickCommandsSnapshot) => void>();

function emit() {
  for (const listener of listeners) listener(cache);
}

function setCache(patch: Partial<QuickCommandsSnapshot>) {
  cache = { ...cache, ...patch };
  emit();
}

async function fetchIntoCache(): Promise<void> {
  setCache({ loading: true });
  try {
    const res = await authenticatedFetch('/api/quick-commands');
    if (res.ok) {
      const data = await res.json();
      setCache({
        commands: Array.isArray(data.commands) ? data.commands : [],
        settings: data.settings
          ? {
              mode: data.settings.mode ?? DEFAULT_SETTINGS.mode,
              model: data.settings.model ?? DEFAULT_SETTINGS.model,
              send_mode: data.settings.send_mode ?? DEFAULT_SETTINGS.send_mode,
            }
          : cache.settings,
      });
      hasLoaded = true;
    }
  } catch (err) {
    console.error('Failed to load quick commands', err);
  } finally {
    setCache({ loading: false });
  }
}

// First mount kicks the one shared fetch; concurrent callers await the same
// promise instead of firing duplicates.
function loadOnce(): Promise<void> {
  if (hasLoaded) return Promise.resolve();
  if (!inFlight) {
    inFlight = fetchIntoCache().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// Force a refetch (used after a mutation) so every subscribed pane updates.
function refreshShared(): Promise<void> {
  hasLoaded = false;
  return loadOnce();
}

export function useQuickCommands() {
  const [snap, setSnap] = useState<QuickCommandsSnapshot>(cache);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    const listener = (next: QuickCommandsSnapshot) => setSnap(next);
    listeners.add(listener);
    // Sync immediately in case the cache changed between render and subscribe.
    if (snapRef.current !== cache) setSnap(cache);
    void loadOnce();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const commands = snap.commands;
  const settings = snap.settings;
  const loading = snap.loading;
  const setSettings = useCallback((updater: (prev: QuickCommandSettings) => QuickCommandSettings) => {
    setCache({ settings: updater(cache.settings) });
  }, []);
  const refresh = useCallback(() => refreshShared(), []);

  const create = useCallback(
    async (input: QuickCommandInput) => {
      const res = await authenticatedFetch('/api/quick-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh]
  );

  const update = useCallback(
    async (id: number, input: Partial<QuickCommandInput>) => {
      const res = await authenticatedFetch(`/api/quick-commands/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: number) => {
      const res = await authenticatedFetch(`/api/quick-commands/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh]
  );

  const saveSettings = useCallback(async (next: Partial<QuickCommandSettings>) => {
    // optimistic (updates the shared cache → all panes)
    setSettings((prev) => ({ ...prev, ...next }));
    const res = await authenticatedFetch('/api/quick-commands/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.settings) setSettings(() => data.settings);
    }
    return res.ok;
  }, [setSettings]);

  // Opt-in native `claude -p` refine. Returns ranked command ids (best first).
  const suggestLlm = useCallback(async (agentText: string): Promise<number[]> => {
    try {
      const res = await authenticatedFetch('/api/quick-commands/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentText }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.rankedIds) ? data.rankedIds : [];
    } catch {
      return [];
    }
  }, []);

  // Per-command custom prompt: run it (native claude -p) against the agent's
  // last message and return the generated text.
  const runCommand = useCallback(
    async (id: number, agentText: string): Promise<string | null> => {
      try {
        const res = await authenticatedFetch(`/api/quick-commands/${id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentText }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data.text === 'string' ? data.text : null;
      } catch {
        return null;
      }
    },
    []
  );

  return {
    commands,
    settings,
    loading,
    refresh,
    create,
    update,
    remove,
    saveSettings,
    suggestLlm,
    runCommand,
  };
}

// ---------------------------------------------------------------------------
// Free, instant, client-side heuristic: classify the agent's last message into
// a state so the matching-trigger chips can be surfaced. No model call.
// ---------------------------------------------------------------------------
export function detectAgentState(text: string): TriggerState | null {
  if (!text) return null;
  const tail = text.trim().toLowerCase().slice(-500);
  if (/\b(error|failed|failure|exception|traceback|cannot |could not |unable to |went wrong)\b/.test(tail)) {
    return 'error';
  }
  if (
    tail.endsWith('?') ||
    /\b(should i|which (one|option|approach)|do you want|would you like|shall i|let me know|please (confirm|clarify|provide)|\(y\/n\)|option [1-9a-c]\b)/.test(tail)
  ) {
    return 'question';
  }
  if (/\b(done|complete|completed|finished|all set|implemented|fixed|ready|success|verified|passing)\b/.test(tail)) {
    return 'done';
  }
  return 'idle';
}

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Shared show/hide state for the quick-command chip row.
//
// The chip row sits between the messages and the composer. When the user hides
// it, the bar renders NOTHING (zero height) so the flex-1 messages pane expands
// into that space — hiding actually gives the room to the chat, which is the
// whole point. The toggle lives in the composer toolbar so it never costs a row
// of its own.
//
// State is module-level (one source of truth) and localStorage-backed, so every
// split-view pane and the single view agree, and the choice survives reloads.
// The bar also auto-hides after a command is used (stops eating height each turn).
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'quick-commands-visible';

function read(): boolean {
  try {
    // Default visible (null → true); only an explicit "0" hides it.
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

let visible = read();
const listeners = new Set<(v: boolean) => void>();

export function setQuickCommandsVisible(next: boolean) {
  if (next === visible) return;
  visible = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // ignore quota / private-mode failures
  }
  for (const listener of listeners) listener(visible);
}

export function useQuickCommandsVisible(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(visible);
  useEffect(() => {
    const listener = (next: boolean) => setV(next);
    listeners.add(listener);
    if (v !== visible) setV(visible);
    return () => {
      listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [v, setQuickCommandsVisible];
}

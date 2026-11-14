const POLL_MS = 10_000;

type Registered = { refresh: () => void; polls: () => boolean };

const registered = new Set<Registered>();
let timer: ReturnType<typeof setInterval> | undefined;

const pollVisible = () => {
  if (document.visibilityState !== 'visible') return;
  registered.forEach((entry) => entry.polls() && entry.refresh());
};

/**
 * Used by useForemanResource: every loaded resource registers here, so one clock refreshes them all at the same moment,
 * and the counts a screen shows never disagree with the lists they count. The clock stops while the tab is hidden and
 * refreshes at once when the tab comes back.
 */
export function registerResource(entry: Registered): () => void {
  registered.add(entry);
  if (registered.size === 1) {
    timer = setInterval(pollVisible, POLL_MS);
    document.addEventListener('visibilitychange', pollVisible);
  }
  return () => {
    registered.delete(entry);
    if (registered.size === 0) {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', pollVisible);
    }
  };
}

/** Used by every action that changes Foreman's state: all loaded resources refresh together, including the ones that have stopped polling. */
export function refreshAll(): void {
  registered.forEach((entry) => entry.refresh());
}

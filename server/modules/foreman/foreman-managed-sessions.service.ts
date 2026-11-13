const MANAGED_KEY_PREFIX = 'foreman.managed:';

/** Key-value storage the managed-session store persists through (cloudcli's `app_config` table in production). */
export type ManagedSessionBacking = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

/**
 * Remembers which sessions were started through the Foreman bridge (`POST /api/foreman/sessions`), so the runtime can give
 * only those the worker autocompact threshold. A session the user started in the UI is never marked, even in a Foreman repo.
 *
 * Reads are served from memory and fall back to the backing store, so the mark survives a cloudcli restart (a resumed
 * session keeps its threshold). A failing backing store never breaks a run: the in-memory mark still works for this process.
 */
// Consumed by foreman.module.ts, which shares one store between the bridge's session start and the runtime hooks.
export function createManagedSessionStore(backing: ManagedSessionBacking) {
  const marked = new Set<string>();

  return {
    mark(sessionId: string): void {
      marked.add(sessionId);
      try {
        backing.set(`${MANAGED_KEY_PREFIX}${sessionId}`, '1');
      } catch {
        // Persistence is best effort; the in-memory mark above still serves this process.
      }
    },
    has(sessionId: string): boolean {
      if (marked.has(sessionId)) {
        return true;
      }
      try {
        if (backing.get(`${MANAGED_KEY_PREFIX}${sessionId}`) === '1') {
          marked.add(sessionId);
          return true;
        }
      } catch {
        // Unreadable store: treat as not marked.
      }
      return false;
    },
  };
}

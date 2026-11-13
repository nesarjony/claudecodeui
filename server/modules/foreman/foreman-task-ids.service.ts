const TASK_ID_KEY_PREFIX = 'foreman.taskId:';

/** Key-value storage the task-id store persists through (cloudcli's `app_config` table in production). */
export type TaskIdBacking = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

/**
 * Remembers which Foreman task started each session, so every event for that session can carry
 * its `taskId`.
 *
 * Reads are served from memory and fall back to the backing store, so the link survives a cloudcli
 * restart. A backing store that fails never breaks the bridge: the in-memory value still works for
 * this process and the failure is swallowed.
 */
// Consumed by foreman.module.ts, which shares one store between session start and event stamping.
export function createTaskIdStore(backing: TaskIdBacking) {
  const remembered = new Map<string, string>();

  return {
    set(sessionId: string, taskId: string): void {
      remembered.set(sessionId, taskId);
      try {
        backing.set(`${TASK_ID_KEY_PREFIX}${sessionId}`, taskId);
      } catch {
        // Persistence is best effort; the in-memory link above still serves this process.
      }
    },
    get(sessionId: string): string | null {
      const cached = remembered.get(sessionId);
      if (cached !== undefined) {
        return cached;
      }
      try {
        const stored = backing.get(`${TASK_ID_KEY_PREFIX}${sessionId}`);
        if (stored) {
          remembered.set(sessionId, stored);
        }
        return stored;
      } catch {
        return null;
      }
    },
  };
}

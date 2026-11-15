import type { ForemanSessionStateRow } from '@/modules/database/index.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';
import { isErrorTurnResult } from '@/shared/utils.js';

/**
 * The status a runtime event leaves a session in, or null when it does not change it. `pending` holds the ids of the session's unanswered
 * permission prompts and is updated here.
 */
// Consumed by foreman-session-state.service.ts, which moves a tracked session's status with it on every runtime event.
export function deriveSessionStatus(
  event: ClaudeRuntimeEvent,
  current: ForemanSessionStateRow['status'],
  pending: Set<string>,
): ForemanSessionStateRow['status'] | null {
  switch (event.kind) {
    case 'run_started':
      pending.clear();
      return 'running';
    case 'permission_request':
      pending.add(event.requestId);
      return 'waiting_permission';
    case 'permission_resolved':
      // Whoever answers (the chat UI, the bridge, a timeout or an abort), the session leaves
      // `waiting_permission` only when its last prompt is gone, and never once the run has already ended.
      pending.delete(event.requestId);
      return current === 'waiting_permission' && pending.size === 0 ? 'running' : null;
    case 'turn_result':
      return isErrorTurnResult(event.message) ? 'error' : 'idle';
    case 'run_error':
      return 'error';
    case 'run_ended':
      pending.clear();
      if (event.reason === 'error') {
        return 'error';
      }
      return current === 'running' || current === 'waiting_permission' ? 'idle' : null;
    default:
      return null;
  }
}

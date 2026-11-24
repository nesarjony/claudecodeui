import type { NormalizedMessage } from '@/shared/types';

/**
 * The kinds that are rows of the conversation.
 *
 * Every other kind on the chat socket is a control or app event — run
 * lifecycle, permission prompts, sidebar deltas — that has
 * its own consumer and no place in the transcript. `stream_delta` is a row as
 * well, though the realtime handler buffers it on its own path.
 */
const TRANSCRIPT_ROW_KINDS: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'error',
  'task_notification',
  'stream_delta',
]);

// Consumed by the realtime handler, which appends only these kinds, and by the guard below.
export function isTranscriptRowKind(kind: unknown): boolean {
  return typeof kind === 'string' && TRANSCRIPT_ROW_KINDS.has(kind);
}

const warnedKinds = new Set<string>();

/**
 * Returns the row with a string id, or `null` when it cannot have one.
 *
 * The merge keys on `id`, so a row without one cannot be merged. A conversation
 * row the server sequenced gets an id from its place in the run, so a replay of
 * the same frame gets the same id. Anything else is refused, with one warning
 * per kind so a stream of such frames does not flood the console.
 */
// Consumed by the session store's appendRealtime.
export function withRealtimeRowId(sessionId: string, message: NormalizedMessage): NormalizedMessage | null {
  if (typeof message.id === 'string' && message.id) {
    return message;
  }

  if (isTranscriptRowKind(message.kind) && typeof message.seq === 'number' && Number.isFinite(message.seq)) {
    return { ...message, id: `${message.kind}_seq${message.seq}_${message.timestamp ?? ''}` };
  }

  const kind = typeof message.kind === 'string' ? message.kind : 'unknown';
  if (!warnedKinds.has(kind)) {
    warnedKinds.add(kind);
    console.warn(
      `[SessionStore] Dropped a live "${kind}" row without an id for session ${sessionId}: the transcript cannot merge it.`,
    );
  }
  return null;
}

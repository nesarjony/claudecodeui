import type { ClaudeRuntimeEvent, ForemanBridgeEventBody } from '@/shared/types.js';
import { clipText, summarizeToolInput } from '@/shared/utils.js';

/**
 * The last line of a worker's final message when it claims its batch is done. The brief's output contract tells the worker to end with
 * it; only a line that is exactly this counts, so a sentence that merely mentions it claims nothing. A claim is not evidence: Foreman's
 * judge grades the work from the repository.
 */
export const DONE_MARKER = 'FOREMAN-RESULT: done';

const MAX_TURN_TEXT = 8000;
const MAX_ERROR_TEXT = 500;
const MAX_REFUSAL_TEXT = 400;
const MAX_PERMISSION_DETAIL = 1000;

type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function claimsDone(text: string): boolean {
  const lastLine = text.trimEnd().split('\n').at(-1);
  return lastLine?.trim() === DONE_MARKER;
}

function refusalText(source: RecordValue | null): string {
  const explanation = asString(source?.api_refusal_explanation) ?? asString(source?.explanation);
  const category = asString(source?.api_refusal_category) ?? asString(source?.category);
  return clipText(explanation ?? (category ? `The model refused the request (${category}).` : 'The model refused the request.'), MAX_REFUSAL_TEXT);
}

function describeFailedTurn(message: RecordValue): string {
  const errors = Array.isArray(message.errors) ? message.errors.filter((entry): entry is string => typeof entry === 'string') : [];
  const subtype = asString(message.subtype) ?? 'error';
  return clipText(errors.length > 0 ? `The turn ended with ${subtype}: ${errors.slice(0, 5).join('; ')}` : `The turn ended with ${subtype}.`, MAX_ERROR_TEXT);
}

/**
 * The event Foreman receives for one runtime observation, or `null` when it has none (a session starting, a compaction, a run that
 * simply ends after its turn). A failed turn is an `error`, not a `turn_end`; a request refused with a 429 that the CLI gave up on is a `quota`; an aborted run is a `session_end` that was stopped and a
 * failed one a `session_end` that crashed. Pure: `commitCount` is what the turn committed, worked out by the caller.
 */
// Consumed by foreman-event-recorder.service.ts for every runtime event of a session the bridge drives.
export function translateRuntimeEvent(event: ClaudeRuntimeEvent, context: { commitCount: number }): ForemanBridgeEventBody | null {
  switch (event.kind) {
    case 'turn_result': {
      const message = event.message;
      if (message.is_error === true || String(message.subtype ?? '').startsWith('error')) {
        return { kind: 'error', payload: { message: describeFailedTurn(message) } };
      }
      const text = asString(message.result) ?? '';
      const usage = asRecord(message.usage);
      const billedModels = Object.keys(asRecord(message.modelUsage) ?? {});
      return {
        kind: 'turn_end',
        payload: {
          text: clipText(text, MAX_TURN_TEXT),
          commitCount: context.commitCount,
          claimsDone: claimsDone(text),
          // The model the runtime saw answering; when it saw none, the only model the turn billed.
          model: event.model ?? (billedModels.length === 1 ? billedModels[0] ?? null : null),
          usage: {
            inputTokens: asNumber(usage?.input_tokens),
            outputTokens: asNumber(usage?.output_tokens),
            cacheReadTokens: asNumber(usage?.cache_read_input_tokens),
            cacheCreationTokens: asNumber(usage?.cache_creation_input_tokens),
          },
        },
      };
    }
    case 'permission_request':
      return { kind: 'permission_request', payload: { requestId: event.requestId, tool: event.toolName, detail: summarizeToolInput(event.input, MAX_PERMISSION_DETAIL) } };
    case 'assistant_refusal':
      return { kind: 'refusal', payload: { text: refusalText(asRecord(asRecord(event.message.message)?.stop_details)) } };
    // The SDK classifies a request the CLI gave up on after a 429 as `rate_limit`; any other class is reported by the failed turn that follows.
    case 'assistant_error':
      return event.error === 'rate_limit' ? { kind: 'quota', payload: { message: clipText(event.text || 'The worker was refused with a 429.', MAX_ERROR_TEXT) } } : null;
    case 'system_message': {
      const subtype = asString(event.message.subtype);
      return subtype === 'model_refusal_fallback' || subtype === 'model_refusal_no_fallback'
        ? { kind: 'refusal', payload: { text: refusalText(event.message) } }
        : null;
    }
    case 'run_error':
      return { kind: 'error', payload: { message: clipText(event.message, MAX_ERROR_TEXT) } };
    case 'run_ended':
      if (event.reason === 'aborted') return { kind: 'session_end', payload: { reason: 'stopped' } };
      return event.reason === 'error' ? { kind: 'session_end', payload: { reason: 'crashed' } } : null;
    default:
      return null;
  }
}

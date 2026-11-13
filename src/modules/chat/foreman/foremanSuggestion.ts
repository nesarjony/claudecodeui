/**
 * The "Foreman suggests" card's data model and the rules for turning a Foreman decision into what the card offers.
 * Pure (no React, no i18n), so the mapping is unit-tested on its own.
 *
 * Foreman (the supervisor service) decides after every turn and cloudcli relays its suggestion here, over the chat
 * WebSocket (`foreman_suggestion` frames) and from `GET /api/foreman-suggestions/pending` when a chat opens.
 */

export const FOREMAN_ACTIONS = [
  'continue',
  'steer',
  'demand_evidence',
  'answer',
  'delegate',
  'split',
  'switch_model',
  'write_notes',
  'compact',
  'handoff',
  'run_judge',
  'needs_user',
  'stop',
] as const;
export type ForemanAction = (typeof FOREMAN_ACTIONS)[number];

export type ForemanRisk = 'low' | 'medium' | 'high';
export type ForemanSuggestionStatus = 'pending' | 'sent' | 'edited' | 'dismissed' | 'superseded' | 'expired';
/** What the user did with a suggestion: the words Foreman's feedback endpoint takes. */
export type ForemanFeedbackAction = 'sent' | 'edited' | 'dismissed';

/** The decision the card shows (after Foreman's own policy rules). */
export type ForemanDecision = {
  reason: string;
  action: ForemanAction;
  confidence: number;
  risk: ForemanRisk;
  message?: string;
  model?: string;
  instructions?: string;
  question?: string;
};

export type ForemanSuggestion = {
  id: string;
  sessionId: string;
  status: ForemanSuggestionStatus;
  decision: {
    decision: ForemanDecision;
    /** The model that decided (`api-haiku`, `api-sonnet`, ...). */
    model: string;
    promptVersion?: string;
    escalated?: boolean;
  };
  createdAt?: string;
};

const STATUSES: readonly string[] = ['pending', 'sent', 'edited', 'dismissed', 'superseded', 'expired'];
const RISKS: readonly string[] = ['low', 'medium', 'high'];

/** Narrows an untrusted frame or response body to a suggestion the card can render. */
export function isForemanSuggestion(value: unknown): value is ForemanSuggestion {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.sessionId !== 'string') return false;
  if (typeof s.status !== 'string' || !STATUSES.includes(s.status)) return false;
  const outer = s.decision as Record<string, unknown> | null | undefined;
  const d = outer?.decision as Record<string, unknown> | null | undefined;
  if (!outer || !d || typeof d !== 'object') return false;
  return (
    typeof outer.model === 'string' &&
    (FOREMAN_ACTIONS as readonly string[]).includes(String(d.action)) &&
    typeof d.reason === 'string' &&
    typeof d.confidence === 'number' &&
    RISKS.includes(String(d.risk))
  );
}

/** Actions Foreman can name but the shadow-mode card cannot carry out yet: the card only says what was suggested. */
export const SHADOW_UNAVAILABLE_ACTIONS: readonly ForemanAction[] = ['delegate', 'split', 'handoff', 'run_judge', 'write_notes'];

/** What Send posts for a `continue` that came without a message. */
export const DEFAULT_CONTINUE_TEXT = 'Please continue.';

/** Foreman's model aliases and the cloudcli model family each one means. */
const ALIAS_TO_FAMILY: Record<string, string> = {
  'api-opus': 'opus',
  'api-sonnet': 'sonnet',
  'api-haiku': 'haiku',
};
const API_KEY_MARKER = '@api';

/**
 * The cloudcli model value a Foreman `switch_model` alias stands for, or null when it is already the session's model
 * (or is not a model the card knows). The `@api` billing marker of the current model is kept, so a session on the API
 * key stays on the API key. A value that is not a Foreman alias is passed through as a cloudcli model id.
 */
export function foremanModelToCloudcli(alias: string | undefined, currentModel: string | null): string | null {
  if (!alias) return null;
  const family = ALIAS_TO_FAMILY[alias] ?? (alias.startsWith('api-') ? null : alias);
  if (!family) return null;
  const apiBilled = Boolean(currentModel?.endsWith(API_KEY_MARKER));
  const target = family.endsWith(API_KEY_MARKER) || !apiBilled ? family : `${family}${API_KEY_MARKER}`;
  const bare = (model: string | null) => (model ?? '').replace(API_KEY_MARKER, '').replace(/\[1m\]$/, '');
  // Already on that model family (e.g. `claude-opus-5-5` while Foreman says opus): nothing to switch.
  if (currentModel && (currentModel === target || bare(currentModel) === bare(target) || bare(currentModel).includes(bare(target)))) {
    return null;
  }
  return target;
}

/** What the card offers for one suggestion. */
export type SuggestionPlan =
  /** A message to send to the worker. `edit` puts the same text in the composer instead. */
  | { kind: 'send'; text: string }
  /** A model switch through the existing model picker. */
  | { kind: 'switch_model'; alias: string; model: string }
  /** Nothing to press: a question for the user, a reason to stop, or an action shadow mode cannot run yet. */
  | { kind: 'info'; text: string; unavailable: boolean };

const nonEmpty = (value: string | undefined): string | undefined => (value && value.trim() ? value.trim() : undefined);

/**
 * Turns a decision into the card's offer:
 *  - continue / steer / answer / demand_evidence: send the message (a bare `continue` sends "Please continue.");
 *  - compact: send `/compact <instructions>`;
 *  - switch_model: a "Switch to X" button, unless the session is already on X;
 *  - needs_user / stop: information only (the question or the reason);
 *  - delegate / split / handoff / run_judge / write_notes: information only, marked not available in shadow mode.
 */
export function planSuggestion(suggestion: ForemanSuggestion, context: { currentModel: string | null }): SuggestionPlan {
  const d = suggestion.decision.decision;
  const reason = nonEmpty(d.reason) ?? '';
  switch (d.action) {
    case 'continue':
      return { kind: 'send', text: nonEmpty(d.message) ?? DEFAULT_CONTINUE_TEXT };
    case 'steer':
    case 'answer':
    case 'demand_evidence': {
      const text = nonEmpty(d.message);
      return text ? { kind: 'send', text } : { kind: 'info', text: reason, unavailable: false };
    }
    case 'compact': {
      const instructions = nonEmpty(d.instructions);
      return { kind: 'send', text: instructions ? `/compact ${instructions}` : '/compact' };
    }
    case 'switch_model': {
      const model = foremanModelToCloudcli(d.model, context.currentModel);
      return model && d.model
        ? { kind: 'switch_model', alias: d.model, model }
        : { kind: 'info', text: reason, unavailable: false };
    }
    case 'needs_user':
      return { kind: 'info', text: nonEmpty(d.question) ?? reason, unavailable: false };
    case 'stop':
      return { kind: 'info', text: reason, unavailable: false };
    default:
      return { kind: 'info', text: nonEmpty(d.instructions) ?? reason, unavailable: SHADOW_UNAVAILABLE_ACTIONS.includes(d.action) };
  }
}

/** `api-haiku` to `Haiku`: how the deciding model is named on the card. */
export function foremanModelLabel(alias: string): string {
  const family = (ALIAS_TO_FAMILY[alias] ?? alias.replace(/^api-/, '')).replace(API_KEY_MARKER, '');
  return family ? family.charAt(0).toUpperCase() + family.slice(1) : alias;
}

export const confidencePercent = (confidence: number): number => Math.round(Math.min(1, Math.max(0, confidence)) * 100);

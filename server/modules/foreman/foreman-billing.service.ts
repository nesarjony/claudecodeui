/**
 * The billing markers of the Foreman bridge: how a model value carries its billing mode (`@api`, `@cap`, or none for the subscription), read and
 * written in one place so a session's model and its billing never drift apart.
 */

import type { ForemanBilling } from '@/shared/types.js';

/** Model marker that bills a Claude session to the Anthropic API key (see claude-models.provider.ts). */
const API_KEY_MODEL_MARKER = '@api';
/** Model marker that runs a Claude session through claude-cap's worker profile (see claude-models.provider.ts). */
const CAP_MODEL_MARKER = '@cap';

/**
 * Splits a stored model value into the plain model and its billing mode. A model carrying the `@api` marker runs on the
 * API key, one carrying `@cap` runs through claude-cap's worker profile; anything else (including no model) runs on the
 * subscription. If a value carries more than one marker, the outermost (last) one decides and all of them are removed.
 */
// Consumed by foreman-sessions.service.ts for listings and for the billing checks of a send and a model switch.
export function splitModelBilling(model: string | null | undefined): { model: string | null; billing: ForemanBilling } {
  let plain = typeof model === 'string' ? model.trim() : '';
  if (!plain) {
    return { model: null, billing: 'subscription' };
  }
  let billing: ForemanBilling | null = null;
  for (let marker = readMarker(plain); marker; marker = readMarker(plain)) {
    billing ??= marker.billing;
    plain = plain.slice(0, -marker.text.length);
  }
  return { model: plain || null, billing: billing ?? 'subscription' };
}

function readMarker(model: string): { text: string; billing: ForemanBilling } | null {
  if (model.endsWith(API_KEY_MODEL_MARKER)) {
    return { text: API_KEY_MODEL_MARKER, billing: 'api-key' };
  }
  if (model.endsWith(CAP_MODEL_MARKER)) {
    return { text: CAP_MODEL_MARKER, billing: 'cap' };
  }
  return null;
}

/** The billing a model value declares through its marker; null for a value with no marker (it declares nothing). */
// Consumed by foreman.routes.ts: a session started with a marked model and no explicit billing keeps the marker's billing.
export function declaredModelBilling(model: string | null | undefined): ForemanBilling | null {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return readMarker(trimmed)?.billing ?? null;
}

/**
 * Applies a billing mode to a plain model value: replaces any marker by the one of `billing` (`@api` for `api-key`,
 * `@cap` for `cap`) and adds none for `subscription`.
 */
// Consumed by foreman-sessions.service.ts when starting sessions and switching models.
export function applyModelBilling(model: string, billing: ForemanBilling): string {
  const plain = splitModelBilling(model).model ?? model.trim();
  if (billing === 'api-key') {
    return `${plain}${API_KEY_MODEL_MARKER}`;
  }
  return billing === 'cap' ? `${plain}${CAP_MODEL_MARKER}` : plain;
}

import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { createMockApi } from '@/modules/foreman-next/api/mock/mockClient';
import { MOCK_SCENARIOS } from '@/modules/foreman-next/api/mock/scenarios';
import { createRealApi } from '@/modules/foreman-next/api/realClient';

const MODES = ['mock', 'real'] as const;

const mode = MODES.find((candidate) => candidate === import.meta.env.VITE_FOREMAN_NEXT_API) ?? null;

/** Used by the barrel and the Foreman routes: the new UI stays off until `VITE_FOREMAN_NEXT_API` is `mock` or `real`, so the live app is unchanged until the owner switches over. */
export const FOREMAN_NEXT_ENABLED = mode !== null;

let shared: ForemanApi | null = null;

/**
 * The one place that chooses the implementation: `VITE_FOREMAN_NEXT_API=real` selects the HTTP client, `mock` the sample
 * data. One instance serves the whole app, so the mock keeps its state between the Foreman screens and the session view.
 * The mock reads a `scenario` query parameter (see MOCK_SCENARIOS) to show the special states.
 */
export function getForemanApi(): ForemanApi {
  if (!shared) {
    const requested = new URLSearchParams(window.location.search).get('scenario');
    shared = mode === 'real' ? createRealApi() : createMockApi({ scenario: MOCK_SCENARIOS.find((scenario) => scenario === requested) ?? 'default' });
  }
  return shared;
}

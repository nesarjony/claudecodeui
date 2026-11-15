import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { createRealApi } from '@/modules/foreman-next/api/realClient';

/**
 * The one place that chooses the implementation, by the build-time flag `VITE_FOREMAN_NEXT_API`: `real` talks to
 * cloudcli's proxy, `mock` answers from sample data (and reads a `scenario` query parameter to show the special states).
 * The mock is loaded behind the literal comparison, so a `real` build contains none of it.
 */
export async function loadForemanApi(): Promise<ForemanApi> {
  if (import.meta.env.VITE_FOREMAN_NEXT_API === 'mock') {
    const [{ createMockApi }, { MOCK_SCENARIOS }] = await Promise.all([import('@/modules/foreman-next/api/mock/mockClient'), import('@/modules/foreman-next/api/mock/scenarios')]);
    const requested = new URLSearchParams(window.location.search).get('scenario');
    return createMockApi({ scenario: MOCK_SCENARIOS.find((scenario) => scenario === requested) ?? 'default' });
  }
  return createRealApi();
}

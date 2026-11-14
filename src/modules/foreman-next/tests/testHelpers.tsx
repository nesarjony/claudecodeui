import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

import { i18n } from '@/modules/i18n';
import '@/modules/foreman-next/i18n';
import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { createMockApi } from '@/modules/foreman-next/api/mock/mockClient';
import type { MockScenario } from '@/modules/foreman-next/api/mock/scenarios';
import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { ForemanNextRoutes } from '@/modules/foreman-next/ForemanNextRoutes';

/** A mock API that answers at once, so tests wait for the screen and not for simulated latency. */
export const quickApi = (scenario: MockScenario = 'default'): ForemanApi => createMockApi({ scenario, latencyMs: 0 });

/** Renders one component with the English catalog, the router and the given API. */
export function renderWithForeman(ui: ReactElement, { api = quickApi(), route = '/foreman' }: { api?: ForemanApi; route?: string } = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ForemanApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ForemanApiProvider>
    </I18nextProvider>,
  );
}

/** Renders the whole Foreman section at a route, the way the app mounts it. */
export function renderForemanApp(route: string, api: ForemanApi = quickApi()) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/foreman/*" element={<ForemanNextRoutes api={api} />} />
          <Route path="/session/:sessionId" element={<p>session view</p>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

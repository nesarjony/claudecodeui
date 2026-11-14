import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ForemanSidebarLink } from '@/modules/foreman-next/sidebar/ForemanSidebarLink';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

describe('the sidebar link', () => {
  it('links into the Foreman section with the count of decisions that block work', async () => {
    renderWithForeman(<ForemanSidebarLink />);
    const link = await screen.findByRole('link', { name: /Foreman/ });
    expect(link.getAttribute('href')).toBe('/foreman');
    expect(await screen.findByLabelText('2 decisions need you')).toBeTruthy();
  });

  it('shows no count when nothing blocks work', async () => {
    renderWithForeman(<ForemanSidebarLink />, { api: quickApi('quiet') });
    await screen.findByRole('link', { name: 'Foreman' });
    expect(screen.queryByLabelText(/need you/)).toBeNull();
  });
});

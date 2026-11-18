import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import type { QuickSettingsPreferences } from '@/shared/types';

/**
 * The "Foreman suggests" switch belongs to the old Foreman: the build made for the rebuilt one (`VITE_FOREMAN_NEXT_API=real`) makes no suggestions,
 * so a switch for them would do nothing.
 */

const quickSettings = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QuickSettingsContent isDarkMode={false} preferences={{ showForemanSuggestions: true } as QuickSettingsPreferences} onPreferenceChange={vi.fn()} />
      </ThemeProvider>
    </I18nextProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the Quick Settings switch for Foreman suggestions', () => {
  it('is there until the build is made for the rebuilt Foreman', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', '');
    quickSettings();
    expect(screen.getByText('Show Foreman suggestions')).toBeTruthy();
    expect(screen.getByText(/suggests the next step/)).toBeTruthy();
  });

  it('is left out, with its explanation, in the build made for the rebuilt Foreman', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'real');
    quickSettings();
    expect(screen.queryByText('Show Foreman suggestions')).toBeNull();
    expect(screen.queryByText(/suggests the next step/)).toBeNull();
  });
});

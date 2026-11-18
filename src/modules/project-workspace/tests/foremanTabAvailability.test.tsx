import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { areForemanSuggestionsAvailable, isForemanTabAvailable } from '@/modules/foreman';
import WorkspaceTabsMenu from '@/modules/project-workspace/WorkspaceTabsMenu';

/**
 * The old Foreman's tab, in the build made for the rebuilt one (`VITE_FOREMAN_NEXT_API=real`): the workspace views menu leaves it out, and a tab
 * remembered from an earlier build opens chat instead of a tab that would only fail.
 */

const openViews = () => {
  render(
    <I18nextProvider i18n={i18n}>
      <WorkspaceTabsMenu activeTab="chat" setActiveTab={vi.fn()} />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Workspace views' }));
  return screen.getAllByRole('menuitemradio').map((item) => item.textContent);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  localStorage.clear();
});

describe('the old Foreman tab', () => {
  it('is available in a build that is not made for the rebuilt Foreman, and in the mock one', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', '');
    expect(isForemanTabAvailable()).toBe(true);
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'mock');
    expect(isForemanTabAvailable()).toBe(true);
  });

  it('is hidden in the build made for the rebuilt Foreman', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'real');
    expect(isForemanTabAvailable()).toBe(false);
  });

  it('is in the workspace views menu until the build is made for the rebuilt Foreman, and then the other views stay', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', '');
    expect(openViews()).toEqual(['Chat', 'Shell', 'Files', 'Source Control', 'Foreman']);
    cleanup();
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'real');
    expect(openViews()).toEqual(['Chat', 'Shell', 'Files', 'Source Control']);
  });
});

/** The "Foreman suggests" card is the old Foreman's as well: the rebuilt one makes none, so its build neither asks for the card nor offers its Quick Settings switch (that one is tested with Quick Settings). */
describe('the old Foreman suggestions', () => {
  it('are available except in the build made for the rebuilt Foreman', () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', '');
    expect(areForemanSuggestionsAvailable()).toBe(true);
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'real');
    expect(areForemanSuggestionsAvailable()).toBe(false);
  });
});

describe('a Foreman tab remembered by the browser', () => {
  beforeEach(() => {
    localStorage.setItem('activeTab', 'foreman');
  });

  const rememberedTab = async () => {
    vi.doMock('@/shared/api', () => ({ api: { projects: () => new Promise(() => undefined), projectTaskmaster: () => Promise.resolve({ ok: false }), sessionDetails: () => Promise.resolve({ ok: false }), projectSessions: () => Promise.resolve({ ok: false }) } }));
    const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
    const { result } = renderHook(() => useProjectsState({ sessionId: undefined, navigate: vi.fn(), subscribe: () => () => undefined, isMobile: false, isSessionProcessing: () => false }));
    return result.current.activeTab;
  };

  it('opens when the old tab is there', async () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', '');
    expect(await rememberedTab()).toBe('foreman');
  });

  it('opens chat in the build made for the rebuilt Foreman', async () => {
    vi.stubEnv('VITE_FOREMAN_NEXT_API', 'real');
    expect(await rememberedTab()).toBe('chat');
  });
});

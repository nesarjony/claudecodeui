import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterAll, test, vi } from 'vitest';

import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type {
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
} from '@/shared/types';

vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));
vi.mock('@/modules/chat/modals/ModelLibraryPanel', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = vi.fn();

afterAll(() => {
  vi.unstubAllGlobals();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const providerModels: Record<LLMProvider, string> = {
  claude: 'default',
  codex: 'gpt-5.6-sol',
  cursor: 'gpt-5.3-codex',
  opencode: 'anthropic/claude-sonnet-4-5',
};

const providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: {
    DEFAULT: 'default',
    OPTIONS: [{ value: 'default', label: 'Default' }],
  },
  codex: {
    DEFAULT: 'gpt-5.6-sol',
    OPTIONS: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
  },
};

const providerModelActions: ProviderModelActions = {
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};

const renderPicker = (newSessionTrigger: number) => render(
  <ProviderSelectionEmptyState
    newSessionTrigger={newSessionTrigger}
    selectedSession={null}
    currentSessionId={null}
    provider="claude"
    setProvider={vi.fn()}
    textareaRef={{ current: null }}
    providerModels={providerModels}
    setProviderModel={vi.fn()}
    providerModelCatalog={providerModelCatalog}
    providerModelActions={providerModelActions}
    providerModelsLoading={false}
    tasksEnabled={false}
    isTaskMasterInstalled={false}
    setInput={vi.fn()}
  />,
);

test('an explicit New Session click opens the provider selector every time', () => {
  const view = renderPicker(0);
  assert.equal(view.queryByRole('dialog'), null, 'ordinary initial load stays unobtrusive');

  view.rerender(
    <ProviderSelectionEmptyState
      newSessionTrigger={1}
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={vi.fn()}
      textareaRef={{ current: null }}
      providerModels={providerModels}
      setProviderModel={vi.fn()}
      providerModelCatalog={providerModelCatalog}
      providerModelActions={providerModelActions}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      setInput={vi.fn()}
    />,
  );
  assert.ok(view.getByRole('dialog'));

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);

  view.rerender(
    <ProviderSelectionEmptyState
      newSessionTrigger={2}
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={vi.fn()}
      textareaRef={{ current: null }}
      providerModels={providerModels}
      setProviderModel={vi.fn()}
      providerModelCatalog={providerModelCatalog}
      providerModelActions={providerModelActions}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      setInput={vi.fn()}
    />,
  );
  assert.ok(view.getByRole('dialog'));
});

test('mounting the empty state from a New Session click opens the selector', () => {
  const view = renderPicker(1);
  assert.ok(view.getByRole('dialog'));
});

import { fireEvent, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, ToolGroupItem } from '@/shared/types';

/**
 * The steps row folds a run of tool calls into one line. What it must never
 * do is hide the parts the user has to act on, or jump in height when a live
 * run finishes.
 */

const createDiff = createCachedDiffCalculator();

const step = (
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-11-12T10:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify(toolInput),
  toolId: `${toolName}-${JSON.stringify(toolInput)}`,
  toolResult: { content: 'ok', isError: false },
  ...overrides,
});

const groupOf = (steps: ChatMessage[]): ToolGroupItem => ({
  _isGroup: true,
  messages: steps,
  steps,
  timestamp: steps[0].timestamp,
});

// The real English catalog, so the summary's counts and durations are
// asserted as the user reads them rather than as raw keys.
const renderRow = (group: ToolGroupItem, isLive = false) => render(
  <I18nextProvider i18n={i18n}>
    <UiPreferencesProvider>
      <ToolGroupContainer
        group={group}
        opensTurn={false}
        isLive={isLive}
        createDiff={createDiff}
        getMessageKey={(message) => String(message.toolId)}
        provider="claude"
      />
    </UiPreferencesProvider>
  </I18nextProvider>,
);

/** The row's own toggle; per-tool rows inside it have toggles of their own. */
const getStepsToggle = (container: HTMLElement) => {
  const toggle = container.querySelector<HTMLButtonElement>('.steps > button[aria-expanded]');
  if (!toggle) throw new Error('steps toggle not rendered');
  return toggle;
};

describe('steps row', () => {
  it('summarizes a finished run by kind and duration, folded', () => {
    const { container } = renderRow(groupOf([
      step('Read', { file_path: '/a.ts' }),
      step('Read', { file_path: '/b.ts' }),
      step('Grep', { pattern: 'x' }, { timestamp: '2026-11-12T10:00:41.000Z' }),
    ]));

    const toggle = getStepsToggle(container);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('3 steps');
    expect(toggle.textContent).toContain('Read ×2 · Search');
    expect(toggle.textContent).toContain('41s');
    // Folded: none of the per-tool rows are mounted.
    expect(container.textContent).not.toContain('b.ts');
  });

  it('expands to the existing per-tool rows', () => {
    const { container } = renderRow(groupOf([
      step('Read', { file_path: '/repo/a.ts' }),
      step('Read', { file_path: '/repo/b.ts' }),
    ]));

    fireEvent.click(getStepsToggle(container));

    expect(getStepsToggle(container).getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('b.ts');
  });

  it('shows the step in flight while live, in the same row', () => {
    const { container } = renderRow(groupOf([
      step('Read', { file_path: '/repo/a.ts' }),
      step('Edit', { file_path: '/repo/implement-parity/SKILL.md' }, { toolResult: null }),
    ]), true);

    const toggle = getStepsToggle(container);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Editing implement-parity/SKILL.md…');
    // Opening the live row is watching it, so it must not detach following.
    expect(toggle.hasAttribute('data-follow-on-expand')).toBe(true);
  });

  it('keeps a failed step visible outside the fold and counts it in the summary', () => {
    const { container } = renderRow(groupOf([
      step('Read', { file_path: '/repo/a.ts' }),
      step('Bash', { command: 'pnpm test' }, { toolResult: { content: '1 test failed', isError: true } }),
      step('Read', { file_path: '/repo/c.ts' }),
    ]));

    const toggle = getStepsToggle(container);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 failed');
    // The failed command is rendered; the successful reads stay folded.
    expect(container.textContent).toContain('pnpm test');
    expect(container.textContent).not.toContain('c.ts');
  });
});

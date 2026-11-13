import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ForemanSuggestionCard from '@/modules/chat/foreman/ForemanSuggestionCard';
import {
  planSuggestion,
  type ForemanDecision,
  type ForemanSuggestion,
} from '@/modules/chat/foreman/foremanSuggestion';

/**
 * The card is the user's whole view of what Foreman suggests: what it would do, why, how sure it is, which model said
 * so, and the buttons. Rendered with the real English catalog, so the labels are asserted as the user reads them.
 */

const make = (decision: Partial<ForemanDecision>, over: Partial<ForemanSuggestion['decision']> = {}): ForemanSuggestion => ({
  id: 'sug_1',
  sessionId: 'session-1',
  status: 'pending',
  decision: {
    decision: { reason: 'No test ran after the last edit.', action: 'demand_evidence', confidence: 0.94, risk: 'low', message: 'Run pnpm verify and paste the output.', ...decision },
    model: 'api-haiku',
    ...over,
  },
});

function setup(suggestion: ForemanSuggestion, options: { defaultOpen?: boolean; currentModel?: string | null } = {}) {
  const handlers = { onSend: vi.fn(), onEdit: vi.fn(), onSwitchModel: vi.fn(), onDismiss: vi.fn() };
  const plan = planSuggestion(suggestion, { currentModel: options.currentModel ?? 'sonnet' });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ForemanSuggestionCard suggestion={suggestion} plan={plan} defaultOpen={options.defaultOpen ?? true} {...handlers} />
    </I18nextProvider>,
  );
  return { ...view, ...handlers };
}

describe('a send suggestion', () => {
  it('shows the action, the proposed message, the reason, the confidence and risk chips and the deciding model', () => {
    setup(make({}));
    const card = screen.getByTestId('foreman-suggestion');
    expect(within(card).getByText('Foreman suggests')).toBeTruthy();
    expect(card.textContent).toContain('Ask for evidence');
    expect(screen.getByTestId('foreman-message').textContent).toBe('Run pnpm verify and paste the output.');
    expect(screen.getByTestId('foreman-reason').textContent).toContain('No test ran after the last edit.');
    expect(screen.getByTestId('foreman-confidence').textContent).toBe('94% sure');
    expect(screen.getByTestId('foreman-risk').textContent).toBe('Low risk');
    expect(screen.getByTestId('foreman-model').textContent).toBe('Haiku');
  });

  it('a second opinion says so, and a risky step is flagged', () => {
    setup(make({ risk: 'high', confidence: 0.55 }, { model: 'api-sonnet', escalated: true }));
    expect(screen.getByTestId('foreman-model').textContent).toBe('Sonnet · 2nd opinion');
    expect(screen.getByTestId('foreman-risk').textContent).toBe('High risk');
    expect(screen.getByTestId('foreman-risk').className).toContain('text-red');
    expect(screen.getByTestId('foreman-confidence').textContent).toBe('55% sure');
  });

  it('Send hands the proposed text to onSend; Edit hands it to onEdit; Dismiss dismisses', () => {
    const { onSend, onEdit, onDismiss } = setup(make({}));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('Run pnpm verify and paste the output.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('Run pnpm verify and paste the output.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('compact sends /compact with the instructions', () => {
    const { onSend } = setup(make({ action: 'compact', message: undefined, instructions: 'keep the task notes' }));
    expect(screen.getByTestId('foreman-message').textContent).toBe('/compact keep the task notes');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('/compact keep the task notes');
  });

  it('a long message scrolls inside the card instead of growing it', () => {
    setup(make({ message: 'word '.repeat(2000) }));
    const className = screen.getByTestId('foreman-message').className;
    expect(className).toContain('max-h-36');
    expect(className).toContain('overflow-y-auto');
    expect(className).toContain('break-words');
  });
});

describe('a model switch', () => {
  it('shows a "Switch to X" button that uses the switch path with the cloudcli model value', () => {
    const { onSwitchModel } = setup(make({ action: 'switch_model', model: 'api-opus', message: undefined }), { currentModel: 'sonnet' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Opus' }));
    expect(onSwitchModel).toHaveBeenCalledWith('opus');
  });
});

describe('information-only suggestions', () => {
  it('needs_user shows the question and only offers Dismiss', () => {
    setup(make({ action: 'needs_user', question: 'Run the migration on staging?', message: undefined }));
    expect(screen.getByTestId('foreman-message').textContent).toBe('Run the migration on staging?');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.queryByTestId('foreman-unavailable')).toBeNull();
  });

  it('stop shows the reason', () => {
    setup(make({ action: 'stop', reason: 'The work is verified complete.', message: undefined }));
    expect(screen.getByTestId('foreman-message').textContent).toBe('The work is verified complete.');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it.each(['delegate', 'split', 'handoff', 'run_judge'] as const)('%s is labelled "not available in shadow mode yet" and cannot be sent', action => {
    setup(make({ action, message: undefined, reason: 'A judge should check this.' }));
    expect(screen.getByTestId('foreman-unavailable').textContent).toBe('Not available in shadow mode yet');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});

describe('folding (phone width)', () => {
  it('folded it is one summary line with a clipped preview and a dismiss button, and the buttons are hidden', () => {
    const { onDismiss } = setup(make({}), { defaultOpen: false });
    const summary = screen.getByRole('button', { name: /Foreman suggests/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('Ask for evidence');
    expect(summary.textContent).toContain('Run pnpm verify and paste the output.');
    expect(summary.querySelector('.truncate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByTestId('foreman-message')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('tapping the summary opens the details; tapping again folds them', () => {
    setup(make({}), { defaultOpen: false });
    const summary = screen.getByRole('button', { name: /Foreman suggests/ });
    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByTestId('foreman-confidence')).toBeTruthy();
    fireEvent.click(summary);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('defaults to folded on a phone-width screen and open on a desktop-width one', () => {
    const original = window.matchMedia;
    try {
      const mq = (matches: boolean) => (() => ({ matches, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
      const card = () => (
        <I18nextProvider i18n={i18n}>
          <ForemanSuggestionCard suggestion={make({})} plan={{ kind: 'send', text: 'x' }} onSend={vi.fn()} onEdit={vi.fn()} onSwitchModel={vi.fn()} onDismiss={vi.fn()} />
        </I18nextProvider>
      );
      window.matchMedia = mq(false);
      const phone = render(card());
      expect(phone.getByRole('button', { name: /Foreman suggests/ }).getAttribute('aria-expanded')).toBe('false');
      phone.unmount();

      window.matchMedia = mq(true);
      const desktop = render(card());
      expect(desktop.getByRole('button', { name: /Foreman suggests/ }).getAttribute('aria-expanded')).toBe('true');
    } finally {
      window.matchMedia = original;
    }
  });

  it('uses the chat tokens and stays inside the composer column (no overflow, same max width)', () => {
    setup(make({}));
    const card = screen.getByTestId('foreman-suggestion');
    expect(card.className).toContain('max-w-[54.25rem]');
    expect(card.className).toContain('border-border');
    expect(card.className).not.toContain('font-mono');
    expect(card.className).not.toContain('overflow-x');
  });
});

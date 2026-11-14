import { act, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import '@/modules/foreman-next/i18n';
import { VetoCountdown } from '@/modules/foreman-next/components/VetoCountdown';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const START = new Date('2026-11-14T12:00:00Z');

const show = (closesAt: string) =>
  render(
    <I18nextProvider i18n={i18n}>
      <VetoCountdown closesAt={closesAt} />
    </I18nextProvider>,
  );

describe('VetoCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the closing time and how long is left', () => {
    show(new Date(START.getTime() + 3 * HOUR + 12 * MINUTE).toISOString());
    expect(screen.getByText(/^closes \d{2}:\d{2} · in 3h 12m$/)).toBeTruthy();
  });

  it('counts down as time passes and turns urgent in the last hour', () => {
    show(new Date(START.getTime() + 3 * HOUR + 12 * MINUTE).toISOString());
    const before = screen.getByText(/in 3h 12m/);
    expect(before.className).not.toContain('font-medium');

    act(() => void vi.advanceTimersByTime(2 * HOUR + 30 * MINUTE));
    const urgent = screen.getByText(/in 42m/);
    expect(urgent.className).toContain('font-medium');
  });

  it('says the window closed once the time is up, and offers nothing to count', () => {
    show(new Date(START.getTime() + 5 * MINUTE).toISOString());
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    expect(screen.getByText('window closed')).toBeTruthy();
    expect(screen.queryByText(/closes/)).toBeNull();
  });

  it('is already closed for a time in the past', () => {
    show(new Date(START.getTime() - MINUTE).toISOString());
    expect(screen.getByText('window closed')).toBeTruthy();
  });
});

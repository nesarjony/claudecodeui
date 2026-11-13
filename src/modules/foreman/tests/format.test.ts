import { describe, expect, it } from 'vitest';

import { formatAgo, formatPercent, formatTokens, formatUsd, repoLabel, shortId } from '@/modules/foreman/format';

describe('formatUsd', () => {
  it('shows more digits for small amounts so cents do not hide real spend', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0043)).toBe('$0.0043');
    expect(formatUsd(0.043)).toBe('$0.043');
    expect(formatUsd(1.2345)).toBe('$1.23');
    expect(formatUsd(25)).toBe('$25.00');
    expect(formatUsd(1234.5)).toBe('$1235');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('formatPercent and formatTokens', () => {
  it('rounds and clamps', () => {
    expect(formatPercent(0.874)).toBe('87%');
    expect(formatPercent(1.7)).toBe('100%');
    expect(formatPercent(-1)).toBe('0%');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  it('picks the largest fitting unit', () => {
    expect(formatAgo('2026-11-13T11:59:30.000Z', now, 'en')).toMatch(/30 ?s/);
    expect(formatAgo('2026-11-13T11:57:00.000Z', now, 'en')).toMatch(/3 ?m/);
    expect(formatAgo('2026-11-13T09:00:00.000Z', now, 'en')).toMatch(/3 ?h/);
    expect(formatAgo('2026-11-10T12:00:00.000Z', now, 'en')).toMatch(/3 ?d/);
  });
  it('is empty for a missing or broken time', () => {
    expect(formatAgo(undefined, now)).toBe('');
    expect(formatAgo('not a date', now)).toBe('');
  });
});

describe('ids and repos', () => {
  it('shortens ids and names repos by their last folder', () => {
    expect(shortId('sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11')).toBe('0b8f6a52');
    expect(shortId('task-123456789', 6)).toBe('task-1');
    expect(repoLabel('/mnt/dev/moveon/desk')).toBe('desk');
    expect(repoLabel('desk')).toBe('desk');
    expect(repoLabel(undefined)).toBe('');
  });
});

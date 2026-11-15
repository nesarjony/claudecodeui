import { describe, expect, it } from 'vitest';

import { formatAgo, formatRemaining, formatSeconds, formatUsd } from '@/modules/foreman-next/utils/foremanFormat';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('formatUsd', () => {
  it('writes whole dollars from $10 up and cents below, as the wireframes do', () => {
    expect([formatUsd(11), formatUsd(200), formatUsd(41.2), formatUsd(0.38), formatUsd(3.1)]).toEqual(['$11', '$200', '$41.20', '$0.38', '$3.10']);
  });
});

describe('formatRemaining', () => {
  it('shows hours and minutes, then minutes, then under a minute', () => {
    expect([formatRemaining(3 * HOUR + 12 * MINUTE), formatRemaining(3 * HOUR), formatRemaining(42 * MINUTE), formatRemaining(20_000)]).toEqual(['3h 12m', '3h', '42m', '<1m']);
  });
});

describe('formatAgo', () => {
  it('uses one unit, and never says 0m', () => {
    expect([formatAgo(2 * HOUR + 5 * MINUTE), formatAgo(40 * MINUTE), formatAgo(3 * 24 * HOUR), formatAgo(5_000)]).toEqual(['2h', '40m', '3d', '1m']);
  });
});

describe('formatSeconds', () => {
  it('keeps one decimal', () => {
    expect(formatSeconds(3100)).toBe('3.1s');
  });
});

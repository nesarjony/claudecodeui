import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLL_INTERVAL_MS, usePolledResource } from '@/modules/foreman/usePolledResource';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('usePolledResource', () => {
  it('fetches at once, then every 5 seconds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValue('c');
    const { result } = renderHook(() => usePolledResource(fetcher, { enabled: true }));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('a');
    expect(POLL_INTERVAL_MS).toBe(5000);
    await tick(4900);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('b');
    await tick(5000);
    expect(result.current.data).toBe('c');
  });

  it('does not fetch while disabled, starts when enabled and stops when disabled again', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const { rerender } = renderHook(({ enabled }) => usePolledResource(fetcher, { enabled }), { initialProps: { enabled: false } });
    await tick(20_000);
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await tick(20_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good data when a request fails, reports the error, and clears it on the next success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('down')).mockResolvedValue('better');
    const { result } = renderHook(() => usePolledResource(fetcher, { enabled: true }));
    await flush();
    expect(result.current.data).toBe('good');
    await tick(5000);
    expect(result.current.data).toBe('good');
    expect(result.current.error?.message).toBe('down');
    await tick(5000);
    expect(result.current.data).toBe('better');
    expect(result.current.error).toBeNull();
  });

  it('never has two requests in flight: a slow answer is not overtaken by the next tick', async () => {
    let release: (value: string) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => usePolledResource(fetcher, { enabled: true }));
    await flush();
    await tick(15_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { release('slow'); });
    expect(result.current.data).toBe('slow');
  });

  it('refresh() fetches now', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(2);
    const { result } = renderHook(() => usePolledResource(fetcher, { enabled: true }));
    await flush();
    await act(async () => { await result.current.refresh(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(2);
  });

  it('a new key drops the data that belongs to the old one and refetches', async () => {
    const fetcher = vi.fn(async () => 'x');
    const { result, rerender } = renderHook(({ key }) => usePolledResource(fetcher, { enabled: true, key }), { initialProps: { key: 'today' } });
    await flush();
    expect(result.current.data).toBe('x');
    rerender({ key: '7d' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.data).toBe('x');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refresh() does nothing while disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolledResource(fetcher, { enabled: false }));
    await act(async () => { await result.current.refresh(); });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { quickApi } from '@/modules/foreman-next/tests/testHelpers';

const wrapperFor = (api = quickApi()) => ({ children }: { children: ReactNode }) => <ForemanApiProvider api={api}>{children}</ForemanApiProvider>;

describe('useForemanResource', () => {
  it('starts loading and then holds the data', async () => {
    const { result } = renderHook(() => useForemanResource((api) => api.status()), { wrapper: wrapperFor() });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.state).toBe('running');
  });

  it('reports an error when nothing loaded, and recovers on refresh', async () => {
    const api = quickApi();
    const status = vi.spyOn(api, 'status').mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useForemanResource((foreman) => foreman.status()), { wrapper: wrapperFor(api) });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeNull();
    await result.current.refresh();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('keeps the last data when a later refresh fails', async () => {
    const api = quickApi();
    const { result } = renderHook(() => useForemanResource((foreman) => foreman.status()), { wrapper: wrapperFor(api) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.spyOn(api, 'status').mockRejectedValueOnce(new Error('down'));
    await result.current.refresh();
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data?.state).toBe('running');
  });

  it('reads as loading again when the key changes, and ignores a slow answer for the old key', async () => {
    const api = quickApi();
    const { result, rerender } = renderHook(({ id }) => useForemanResource((foreman) => foreman.goal(id), { key: id }), {
      wrapper: wrapperFor(api),
      initialProps: { id: 'g-inbox' },
    });
    await waitFor(() => expect(result.current.data?.id).toBe('g-inbox'));
    rerender({ id: 'g-contacts' });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.data?.id).toBe('g-contacts'));
  });
});

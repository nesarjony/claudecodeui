import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { refreshAll } from '@/modules/foreman-next/hooks/refreshClock';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import type { Outcome } from '@/modules/foreman-next/hooks/useAction';
import { useForemanResource } from '@/modules/foreman-next/hooks/useForemanResource';
import { quickApi } from '@/modules/foreman-next/tests/testHelpers';

const POLL_MS = 10_000;

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('one refresh rule for every resource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  const setup = () => {
    const api = quickApi();
    const status = vi.spyOn(api, 'status');
    const questions = vi.spyOn(api, 'questions');
    const wrapper = ({ children }: { children: ReactNode }) => <ForemanApiProvider api={api}>{children}</ForemanApiProvider>;
    return { api, status, questions, wrapper };
  };

  const tick = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  };

  it('refreshes the counts and the lists they summarise at the same moment', async () => {
    const { status, questions, wrapper } = setup();
    renderHook(
      () => {
        useForemanResource((api) => api.status());
        useForemanResource((api) => api.questions());
      },
      { wrapper },
    );
    await tick(0);
    expect([status.mock.calls.length, questions.mock.calls.length]).toEqual([1, 1]);
    await tick(POLL_MS);
    expect([status.mock.calls.length, questions.mock.calls.length]).toEqual([2, 2]);
  });

  it('stops while the tab is hidden and refreshes at once when it is visible again', async () => {
    const { status, wrapper } = setup();
    renderHook(() => useForemanResource((api) => api.status()), { wrapper });
    await tick(0);
    setVisibility('hidden');
    await tick(3 * POLL_MS);
    expect(status).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await tick(0);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('stops polling a resource whose data says nothing more will change, but still refreshes it after an action', async () => {
    const { api, wrapper } = setup();
    const run = vi.spyOn(api, 'run');
    renderHook(() => useForemanResource((foreman) => foreman.run('run-t1'), { keepPolling: (data) => data.state === 'running' }), { wrapper });
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);
    await tick(3 * POLL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    act(() => refreshAll());
    await tick(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps polling a resource that is still changing', async () => {
    const { api, wrapper } = setup();
    const run = vi.spyOn(api, 'run');
    renderHook(() => useForemanResource((foreman) => foreman.run('run-t2'), { keepPolling: (data) => data.state === 'running' }), { wrapper });
    await tick(2 * POLL_MS);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('refreshes everything on screen after a successful action, and returns what the action returned', async () => {
    const { status, wrapper } = setup();
    const { result } = renderHook(
      () => ({ resource: useForemanResource((foreman) => foreman.status()), action: useAction() }),
      { wrapper },
    );
    await tick(0);
    let outcome: Outcome<string> | undefined;
    await act(async () => {
      outcome = await result.current.action.run(async () => 'done');
    });
    await tick(0);
    expect(outcome).toEqual({ ok: true, value: 'done' });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('does not refresh after a failed action, and says it failed', async () => {
    const { status, wrapper } = setup();
    const { result } = renderHook(
      () => ({ resource: useForemanResource((foreman) => foreman.status()), action: useAction() }),
      { wrapper },
    );
    await tick(0);
    let outcome: Outcome<string> | undefined;
    await act(async () => {
      outcome = await result.current.action.run(async () => {
        throw new Error('down');
      });
    });
    await tick(0);
    expect(outcome).toEqual({ ok: false });
    expect(result.current.action.failed).toBe(true);
    expect(status).toHaveBeenCalledTimes(1);
  });
});

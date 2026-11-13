import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * The transcript's scroll position is written from several places: following
 * the live end, the restore after older history is prepended, the search jump
 * and the initial scroll. These pin the cases where that coordination was
 * observably wrong; they are timing bugs, so they are driven on fake timers
 * and a scripted container rather than by clicking.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const buildMessage = (index: number, timestamp: string): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION_A,
  content: `message ${index}`,
  timestamp,
} as NormalizedMessage);

/**
 * jsdom has no layout, so scrollHeight/clientHeight are always 0 and assigning
 * scrollTop emits nothing. These are the exact reads the scroll code makes.
 */
function createContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let scrollTop = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
      writes.push(next);
    },
  });

  return { element: element as HTMLDivElement, writes, scrollHeight };
}

function createStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  // A hydrated slot, so the session-loading effect takes its early return
  // instead of re-fetching on every render.
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderChatSessionState(options: {
  session: ProjectSession;
  store: ReturnType<typeof createStore>;
}) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');

  return renderHook(
    ({ session }: { session: ProjectSession }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: options.store as never,
      }),
    { initialProps: { session: options.session } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // The initial-scroll effect is a separate writer that re-scrolls to the
  // bottom every animation frame until the height settles. It would satisfy an
  // assertion meant for the deferred timer, so it is silenced here — these
  // tests are about which writer wins, and it is not one of the two.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('deferred scroll-to-bottom', () => {
  it('does not yank the view back down when the user scrolls up inside the delay', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // A new row lands while the user is at the bottom: a scroll is armed for +50ms.
    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });

    // ...and the user drags upward before it fires.
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll armed before the user scrolled up must not fire afterwards; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('still sticks to the bottom when the user has not scrolled away', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    // Cleared before the new row lands rather than after: following now pins
    // in the commit that adds the row, not on a timer some ms later, so the
    // row is never painted below the fold first.
    container.writes.length = 0;
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.writes).toContain(container.scrollHeight);
  });
});

/**
 * A container whose geometry the test scripts: content height can grow
 * without a message being added, and the user can move the view, the way a
 * browser does it — by changing scrollTop and then firing `scroll`.
 */
function createScriptedContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const geometry = { scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight };
  const writes: number[] = [];

  Object.defineProperty(element, 'scrollHeight', { get: () => geometry.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => geometry.clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => geometry.scrollTop,
    // Clamped like a browser, so "write scrollHeight" lands on the bottom.
    set: (next: number) => {
      geometry.scrollTop = Math.max(0, Math.min(next, geometry.scrollHeight - geometry.clientHeight));
      writes.push(next);
    },
  });

  // jsdom does not scroll; a smooth scrollTo is modelled as landing at once.
  element.scrollTo = ((options: ScrollToOptions) => {
    element.scrollTop = options.top ?? geometry.scrollTop;
  }) as typeof element.scrollTo;

  const userScrollTo = (top: number) => {
    geometry.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  };

  return { element: element as HTMLDivElement, geometry, writes, userScrollTo };
}

/** Collects every ResizeObserver callback so a test can report a size change. */
function stubResizeObserver() {
  const callbacks: Array<() => void> = [];
  class ScriptedResizeObserver {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ScriptedResizeObserver);
  return { reportResize: () => callbacks.forEach((callback) => callback()) };
}

async function renderFollowingTranscript() {
  const resizeObserver = stubResizeObserver();
  const messages = new Map<string, NormalizedMessage[]>([
    [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z'), buildMessage(1, '2026-01-01T00:00:01.000Z')]],
  ]);
  const store = createStore(messages);
  const view = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store });
  const container = createScriptedContainer(5000, 500);
  (view.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

  // The follow listeners bind on the next commit after the container mounts.
  act(() => {
    view.rerender({ session: { id: SESSION_A } as ProjectSession });
  });

  const appendMessages = (...added: NormalizedMessage[]) => {
    messages.set(SESSION_A, [...messages.get(SESSION_A)!, ...added]);
    act(() => {
      view.rerender({ session: { id: SESSION_A } as ProjectSession });
    });
  };

  return { ...view, container, appendMessages, ...resizeObserver };
}

describe('following the live end', () => {
  it('follows content that grows without a new message', async () => {
    // A streamed delta, a tool result or an image loading makes the page
    // taller without adding a message. Following used to be driven by the
    // message count only, so none of these were followed.
    const { container, reportResize } = await renderFollowingTranscript();

    container.geometry.scrollHeight = 5600;
    act(() => reportResize());

    expect(container.geometry.scrollTop).toBe(5100);
  });

  it('does not read growth that arrives with a scroll event as the user scrolling up', async () => {
    // The old handler re-derived "scrolled up" from distance-to-bottom on every
    // scroll event; 300px of growth plus any scroll event switched following
    // off for good.
    const { result, container, reportResize } = await renderFollowingTranscript();

    container.geometry.scrollHeight = 5300;
    act(() => container.userScrollTo(container.geometry.scrollTop));

    expect(result.current.isUserScrolledUp).toBe(false);
    act(() => reportResize());
    expect(container.geometry.scrollTop).toBe(4800);
  });

  it('detaches on a wheel up, and growth then leaves the view where the user put it', async () => {
    const { result, container, reportResize } = await renderFollowingTranscript();

    act(() => {
      container.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    });
    expect(result.current.isUserScrolledUp).toBe(true);

    container.writes.length = 0;
    container.geometry.scrollHeight = 6000;
    act(() => reportResize());

    assert.deepEqual(container.writes, []);
  });

  it('detaches when a drag moves the view up, even with no wheel or key', async () => {
    const { result, container } = await renderFollowingTranscript();

    act(() => container.userScrollTo(3000));

    expect(result.current.isUserScrolledUp).toBe(true);
  });

  it('re-attaches when the user scrolls back to the bottom', async () => {
    const { result, container, reportResize } = await renderFollowingTranscript();

    act(() => container.userScrollTo(3000));
    expect(result.current.isUserScrolledUp).toBe(true);

    act(() => container.userScrollTo(4490));
    expect(result.current.isUserScrolledUp).toBe(false);

    container.geometry.scrollHeight = 5400;
    act(() => reportResize());
    expect(container.geometry.scrollTop).toBe(4900);
  });

  it('counts the rows that arrive while the user reads back', async () => {
    const { result, container, appendMessages } = await renderFollowingTranscript();

    act(() => container.userScrollTo(2000));
    expect(result.current.newMessageCount).toBe(0);

    appendMessages(
      buildMessage(2, '2026-01-01T00:00:02.000Z'),
      buildMessage(3, '2026-01-01T00:00:03.000Z'),
    );

    expect(result.current.newMessageCount).toBe(2);
    // ...and the view stayed where the user left it.
    expect(container.geometry.scrollTop).toBe(2000);
  });

  it('jump to latest re-attaches and returns to the bottom', async () => {
    const { result, container, reportResize } = await renderFollowingTranscript();

    act(() => container.userScrollTo(1000));
    act(() => result.current.scrollToBottomAndReset());

    expect(result.current.isUserScrolledUp).toBe(false);
    expect(container.geometry.scrollTop).toBe(4500);

    // Content landing mid-glide extends it to the new bottom.
    container.geometry.scrollHeight = 5200;
    act(() => reportResize());
    expect(container.geometry.scrollTop).toBe(4700);
  });
});

describe('search jump ownership', () => {
  it('does not follow the user into the next session', { timeout: 20_000 }, async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
      [SESSION_B, [buildMessage(1, '2026-01-01T00:00:05.000Z')]],
    ]);
    const store = createStore(messages);
    const searchSession = {
      id: SESSION_A,
      __searchTargetSnippet: 'message 0',
      __searchTargetTimestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as ProjectSession;

    const { result, rerender } = await renderChatSessionState({ session: searchSession, store });

    const container = createContainer(5000, 500);
    // The row session B renders. The jump requested against session A resolves
    // by timestamp, and on its last retry it accepts the nearest row it can
    // find — which, after the switch, is this one.
    const sessionBRow = document.createElement('div');
    sessionBRow.setAttribute('data-message-timestamp', '2026-01-01T00:00:05.000Z');
    container.element.appendChild(sessionBRow);

    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // Let the jump arm and start retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The user gives up waiting and opens a different session.
    await act(async () => {
      rerender({ session: { id: SESSION_B } as ProjectSession });
    });

    // Let the whole retry budget elapse (20 retries, 150ms apart).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });

    assert.equal(
      scrollIntoView.mock.calls.length,
      0,
      'a jump requested in the previous session must not scroll the new one',
    );
    assert.equal(
      container.element.querySelectorAll('.search-highlight-flash').length,
      0,
      'and must not flash the search highlight on one of its rows',
    );
  });
});

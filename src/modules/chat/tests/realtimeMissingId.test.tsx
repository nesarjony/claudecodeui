import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type * as Reconciliation from '@/modules/chat/utils/sessionMessageReconciliation';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Foreman broadcasts its suggestions to every open chat socket as a
 * `foreman_suggestion` frame: it has a `kind` and a `sessionId` but no `id`,
 * because it is not a row of the conversation. The realtime handler used to
 * append every kind it did not recognise to the session store, and the merge
 * read `message.id.startsWith(...)` on it. The frame then sat in the session's
 * live rows, so every later append threw too — including the optimistic echo
 * a send appends before it writes to the socket, which is why Enter and Send
 * did nothing until the page was reloaded.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

// Lets one test make the merge throw, to prove a failed merge commits nothing.
const reconciliation = vi.hoisted(() => ({ failNext: false }));

vi.mock('@/modules/chat/utils/sessionMessageReconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof Reconciliation>();
  return {
    ...actual,
    removeOptimisticUserEchoes: (...args: Parameters<typeof actual.removeOptimisticUserEchoes>) => {
      if (reconciliation.failNext) {
        reconciliation.failNext = false;
        throw new Error('merge failed');
      }
      return actual.removeOptimisticUserEchoes(...args);
    },
  };
});

const SESSION = 'session-1';

const row = (id: string, role: 'user' | 'assistant', content: string, second: number): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  provider: 'claude',
  sessionId: SESSION,
  content,
  timestamp: `2026-11-14T15:00:0${second}.000Z`,
} as NormalizedMessage);

const HISTORY = [
  row('claude_1', 'user', 'launch six agents', 1),
  row('claude_2', 'assistant', 'Six agents are running.', 2),
];

// The frame exactly as `createSuggestionBroadcaster` sends it
// (server/modules/foreman/foreman-suggestions.service.ts): no `id`, no `seq`.
const foremanSuggestionFrame = (): ServerEvent => ({
  kind: 'foreman_suggestion',
  sessionId: SESSION,
  suggestion: {
    id: 'sug_6cf7d02a',
    sessionId: SESSION,
    status: 'pending',
    decision: { decision: { action: 'continue', reason: 'agents are still running' } },
  },
  timestamp: '2026-11-14T15:09:54.000Z',
});

// What `useChatSessionState.addMessage` appends for a send, before the socket write.
const optimisticEcho = (content: string): NormalizedMessage => ({
  id: `local_${Date.now()}_abc123`,
  sessionId: SESSION,
  timestamp: new Date().toISOString(),
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content,
} as NormalizedMessage);

beforeEach(() => {
  reconciliation.failNext = false;
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
  return view;
}

const contents = (messages: NormalizedMessage[]) => messages.map((message) => message.content);

describe('appendRealtime with a row that has no id', () => {
  it('never breaks a later send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await loadedStore();

    act(() => {
      result.current.appendRealtime(SESSION, foremanSuggestionFrame() as unknown as NormalizedMessage);
    });
    act(() => {
      result.current.appendRealtime(SESSION, optimisticEcho('are the subagents really proceeding or stuck ?'));
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)), [
      'launch six agents',
      'Six agents are running.',
      'are the subagents really proceeding or stuck ?',
    ]);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('keeps the frame out of the live rows and warns once per kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await loadedStore();

    act(() => {
      result.current.appendRealtime(SESSION, foremanSuggestionFrame() as unknown as NormalizedMessage);
      result.current.appendRealtime(SESSION, foremanSuggestionFrame() as unknown as NormalizedMessage);
    });

    assert.deepEqual(result.current.getSessionSlot(SESSION)?.realtimeMessages, []);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0][0]), /foreman_suggestion/);
  });

  it('gives a sequenced conversation row an id derived from its place in the run', async () => {
    const { result } = await loadedStore();
    const unnamed = {
      kind: 'text',
      role: 'assistant',
      content: 'a reply that lost its id',
      provider: 'claude',
      sessionId: SESSION,
      timestamp: '2026-11-14T15:00:03.000Z',
      seq: 7,
    } as unknown as NormalizedMessage;

    act(() => {
      result.current.appendRealtime(SESSION, unnamed);
    });

    const live = result.current.getSessionSlot(SESSION)?.realtimeMessages ?? [];
    assert.equal(live.length, 1);
    assert.equal(live[0].id, 'text_seq7_2026-11-14T15:00:03.000Z');
    assert.equal(contents(result.current.getMessages(SESSION)).at(-1), 'a reply that lost its id');
  });
});

describe('appendRealtime when the merge throws', () => {
  it('commits nothing and lets the next append through', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await loadedStore();
    const before = result.current.getMessages(SESSION);

    reconciliation.failNext = true;
    act(() => {
      result.current.appendRealtime(SESSION, optimisticEcho('first try'));
    });

    assert.deepEqual(result.current.getSessionSlot(SESSION)?.realtimeMessages, []);
    assert.equal(result.current.getMessages(SESSION), before);
    assert.equal(error.mock.calls.length, 1);

    act(() => {
      result.current.appendRealtime(SESSION, optimisticEcho('second try'));
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)).slice(-1), ['second try']);
  });
});

describe('realtime handler routing', () => {
  async function renderChat() {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { useChatRealtimeHandlers } = await import('@/modules/chat/hooks/useChatRealtimeHandlers');
    let listener: ((event: ServerEvent) => void) | null = null;

    const view = renderHook(() => {
      const store = useSessionStore();
      useChatRealtimeHandlers({
        isActive: true,
        subscribe: (fn) => {
          listener = fn;
          return () => { listener = null; };
        },
        provider: 'claude',
        selectedSession: { id: SESSION } as ProjectSession,
        currentSessionId: SESSION,
        setTokenBudget: () => {},
        pendingPermissionRequests: [],
        setPendingPermissionRequests: () => {},
        streamTimerRef: { current: null },
        accumulatedStreamRef: { current: '' },
        lastSeqRef: { current: new Map() },
        statusCheckSentAtRef: { current: new Map() },
        requestLatestMessages: async () => {},
        sessionStore: store,
      });
      return store;
    });

    await act(async () => {
      await view.result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    const dispatch = (event: ServerEvent) => act(() => { listener?.(event); });
    return { store: view.result, dispatch };
  }

  it('leaves a foreman_suggestion frame to the suggestion card, and the next send still lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, dispatch } = await renderChat();

    dispatch(foremanSuggestionFrame());

    assert.deepEqual(store.current.getSessionSlot(SESSION)?.realtimeMessages, []);
    assert.equal(warn.mock.calls.length, 0);

    act(() => {
      store.current.appendRealtime(SESSION, optimisticEcho('yes continue'));
    });

    assert.deepEqual(contents(store.current.getMessages(SESSION)).slice(-1), ['yes continue']);
  });

  it('appends only conversation rows, not app events it does not know', async () => {
    const { store, dispatch } = await renderChat();

    dispatch({ kind: 'some_future_app_event', sessionId: SESSION, timestamp: '2026-11-14T15:10:00.000Z' });
    dispatch({
      id: 'claude_3',
      kind: 'text',
      role: 'assistant',
      content: 'still running',
      provider: 'claude',
      sessionId: SESSION,
      timestamp: '2026-11-14T15:10:01.000Z',
      seq: 1,
    });

    assert.deepEqual(
      (store.current.getSessionSlot(SESSION)?.realtimeMessages ?? []).map((message) => message.id),
      ['claude_3'],
    );
  });
});

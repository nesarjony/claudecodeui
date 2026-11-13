import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { useForemanSuggestion } from '@/modules/chat/foreman/useForemanSuggestion';
import type { ForemanSuggestion } from '@/modules/chat/foreman/foremanSuggestion';
import type { ServerEvent } from '@/shared/types';

const make = (over: Partial<ForemanSuggestion> = {}, decision: Record<string, unknown> = {}): ForemanSuggestion => ({
  id: 'sug_1',
  sessionId: 'session-1',
  status: 'pending',
  decision: {
    decision: { reason: 'no proof', action: 'demand_evidence', confidence: 0.9, risk: 'low', message: 'Run pnpm verify.', ...decision } as never,
    model: 'api-haiku',
  },
  ...over,
});

const pendingResponse = (suggestion: ForemanSuggestion | null) =>
  ({ ok: true, json: async () => ({ success: true, data: { suggestion } }) }) as unknown as Response;
const ok = () => ({ ok: true, json: async () => ({ success: true, data: {} }) }) as unknown as Response;

/** A fake chat socket: tests push frames into the same subscribe() the real provider exposes. */
function createBus() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (event: ServerEvent) => act(() => listeners.forEach((l) => l(event))),
    count: () => listeners.size,
  };
}

let bus: ReturnType<typeof createBus>;
const wrapper = ({ children }: { children: ReactNode }) => (
  <WebSocketContext.Provider value={{ ws: null, sendMessage: vi.fn(), subscribe: bus.subscribe, isConnected: true }}>
    {children}
  </WebSocketContext.Provider>
);

type Props = { sessionId: string | null; enabled: boolean; currentModel: string | null };

function setup(initial: Partial<Props> = {}) {
  const deps = {
    sendText: vi.fn(),
    fillComposer: vi.fn(),
    switchModel: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn(),
    submitListenerRef: { current: null as ((text: string) => void) | null },
  };
  const rendered = renderHook((props: Props) => useForemanSuggestion({ ...props, ...deps }), {
    wrapper,
    initialProps: { sessionId: 'session-1', enabled: true, currentModel: 'sonnet', ...initial } as Props,
  });
  return { ...rendered, ...deps };
}

beforeEach(() => {
  bus = createBus();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading and live updates', () => {
  it('loads the pending suggestion when the chat opens', async () => {
    const pending = vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make()));
    const { result } = setup();
    await waitFor(() => expect(result.current.suggestion?.id).toBe('sug_1'));
    expect(pending).toHaveBeenCalledWith('session-1');
    expect(result.current.plan).toEqual({ kind: 'send', text: 'Run pnpm verify.' });
  });

  it('shows nothing when there is no pending suggestion, or when the request fails', async () => {
    const spy = vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(null));
    const empty = setup();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(empty.result.current.suggestion).toBeNull();

    spy.mockRejectedValue(new Error('offline'));
    const failing = setup();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(failing.result.current.suggestion).toBeNull();
  });

  it('a pushed suggestion for this session appears; for another session it is ignored', async () => {
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(null));
    const { result } = setup();
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'other', suggestion: make({ sessionId: 'other', id: 'sug_x' }) });
    expect(result.current.suggestion).toBeNull();
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make() });
    expect(result.current.suggestion?.id).toBe('sug_1');
  });

  it('a newer suggestion replaces the card; a malformed frame is ignored', async () => {
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make()));
    const { result } = setup();
    await waitFor(() => expect(result.current.suggestion?.id).toBe('sug_1'));
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: { id: 'garbage' } });
    expect(result.current.suggestion?.id).toBe('sug_1');
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ id: 'sug_2' }, { action: 'continue', message: undefined }) });
    expect(result.current.suggestion?.id).toBe('sug_2');
  });

  it('a superseded update removes the card, and a slow fetch cannot bring it back', async () => {
    let release!: (r: Response) => void;
    vi.spyOn(api.foreman, 'pendingSuggestion').mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const { result } = setup();
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make() });
    expect(result.current.suggestion?.id).toBe('sug_1');
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ status: 'superseded' }) });
    expect(result.current.suggestion).toBeNull();
    await act(async () => release(pendingResponse(make())));
    expect(result.current.suggestion).toBeNull();
  });

  it('a superseded update for a different suggestion leaves the shown one alone', async () => {
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make({ id: 'sug_2' })));
    const { result } = setup();
    await waitFor(() => expect(result.current.suggestion?.id).toBe('sug_2'));
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ id: 'sug_1', status: 'superseded' }) });
    expect(result.current.suggestion?.id).toBe('sug_2');
  });

  it('refetches after the socket reconnects (a push may have been missed)', async () => {
    const pending = vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(null));
    setup();
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
    await bus.emit({ kind: 'websocket_reconnected', timestamp: Date.now() });
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(2));
  });

  it('switching session clears the card, and a late answer for the old session never lands on the new one', async () => {
    let releaseA!: (r: Response) => void;
    vi.spyOn(api.foreman, 'pendingSuggestion').mockImplementation((sessionId: string) =>
      sessionId === 'session-1' ? new Promise<Response>((resolve) => (releaseA = resolve)) : Promise.resolve(pendingResponse(null)));
    const { result, rerender } = setup();
    rerender({ sessionId: 'session-2', enabled: true, currentModel: 'sonnet' });
    await act(async () => releaseA(pendingResponse(make())));
    expect(result.current.suggestion).toBeNull();
  });
});

describe('reconciling with Foreman', () => {
  it('a "none pending" answer clears a card that was superseded while we could not hear about it (toggle off, then on)', async () => {
    const pending = vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make()));
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.suggestion?.id).toBe('sug_1'));

    rerender({ sessionId: 'session-1', enabled: false, currentModel: 'sonnet' });
    expect(result.current.suggestion).toBeNull();

    // While the preference was off the suggestion was superseded; Foreman now has nothing pending.
    pending.mockResolvedValue(pendingResponse(null));
    rerender({ sessionId: 'session-1', enabled: true, currentModel: 'sonnet' });
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(2));
    expect(result.current.suggestion).toBeNull();
  });

  it('a "none pending" answer that was already in flight cannot undo a suggestion pushed in the meantime', async () => {
    let release!: (r: Response) => void;
    vi.spyOn(api.foreman, 'pendingSuggestion').mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const { result } = setup();
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make() });
    expect(result.current.suggestion?.id).toBe('sug_1');
    await act(async () => release(pendingResponse(null)));
    expect(result.current.suggestion?.id).toBe('sug_1');
  });
});

describe('the per-user toggle', () => {
  it('when off nothing is fetched, nothing subscribed and nothing shown; turning it on loads the suggestion', async () => {
    const pending = vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make()));
    const { result, rerender } = setup({ enabled: false });
    await act(async () => undefined);
    expect(pending).not.toHaveBeenCalled();
    expect(bus.count()).toBe(0);
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make() });
    expect(result.current.suggestion).toBeNull();

    rerender({ sessionId: 'session-1', enabled: true, currentModel: 'sonnet' });
    await waitFor(() => expect(result.current.suggestion?.id).toBe('sug_1'));

    rerender({ sessionId: 'session-1', enabled: false, currentModel: 'sonnet' });
    expect(result.current.suggestion).toBeNull();
  });
});

describe('what the user does with a suggestion', () => {
  async function withSuggestion(decision: Record<string, unknown> = {}, currentModel: string | null = 'sonnet') {
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make({}, decision)));
    const feedback = vi.spyOn(api.foreman, 'suggestionFeedback').mockResolvedValue(ok());
    const view = setup({ currentModel });
    await waitFor(() => expect(view.result.current.suggestion).not.toBeNull());
    return { ...view, feedback };
  }

  it('Send: reports "sent", sends the text through the normal path and removes the card', async () => {
    const { result, sendText, feedback } = await withSuggestion();
    act(() => result.current.send('Run pnpm verify.'));
    expect(feedback).toHaveBeenCalledWith('sug_1', { action: 'sent' });
    expect(sendText).toHaveBeenCalledWith('Run pnpm verify.');
    expect(result.current.suggestion).toBeNull();
  });

  it('Send reports before it sends, so the feedback is never behind the run it starts', async () => {
    const { result, sendText, feedback } = await withSuggestion();
    const order: string[] = [];
    feedback.mockImplementation(async () => {
      order.push('feedback');
      return ok();
    });
    sendText.mockImplementation(() => void order.push('send'));
    act(() => result.current.send('Run pnpm verify.'));
    expect(order).toEqual(['feedback', 'send']);
  });

  it('Dismiss: reports "dismissed" and removes the card without sending anything', async () => {
    const { result, sendText, feedback } = await withSuggestion();
    act(() => result.current.dismiss());
    expect(feedback).toHaveBeenCalledWith('sug_1', { action: 'dismissed' });
    expect(sendText).not.toHaveBeenCalled();
    expect(result.current.suggestion).toBeNull();
  });

  it('Edit: puts the text in the composer, removes the card, reports nothing yet, and reports "edited" with the final text on send', async () => {
    const { result, fillComposer, feedback, submitListenerRef } = await withSuggestion();
    act(() => result.current.edit('Run pnpm verify.'));
    expect(fillComposer).toHaveBeenCalledWith('Run pnpm verify.');
    expect(result.current.suggestion).toBeNull();
    expect(feedback).not.toHaveBeenCalled();

    act(() => submitListenerRef.current?.('Run pnpm verify and paste the whole output, not a summary.'));
    expect(feedback).toHaveBeenCalledWith('sug_1', { action: 'edited', finalText: 'Run pnpm verify and paste the whole output, not a summary.' });

    // only the first send after the Edit is reported
    act(() => submitListenerRef.current?.('another message'));
    expect(feedback).toHaveBeenCalledTimes(1);
  });

  it('Edit then sending the text unchanged is reported as "sent", not "edited"', async () => {
    const { result, feedback, submitListenerRef } = await withSuggestion();
    act(() => result.current.edit('Run pnpm verify.'));
    act(() => submitListenerRef.current?.('  Run pnpm verify.  '));
    expect(feedback).toHaveBeenCalledWith('sug_1', { action: 'sent' });
  });

  it('an ordinary message with no Edit before it reports nothing', async () => {
    const { feedback, submitListenerRef } = await withSuggestion();
    act(() => submitListenerRef.current?.('something I typed myself'));
    expect(feedback).not.toHaveBeenCalled();
  });

  it('Switch: uses the model switch path, reports "sent" and removes the card', async () => {
    const { result, switchModel, feedback } = await withSuggestion({ action: 'switch_model', model: 'api-opus', message: undefined });
    expect(result.current.plan).toEqual({ kind: 'switch_model', alias: 'api-opus', model: 'opus' });
    act(() => result.current.switchTo('opus'));
    expect(switchModel).toHaveBeenCalledWith('opus');
    expect(feedback).toHaveBeenCalledWith('sug_1', { action: 'sent' });
    expect(result.current.suggestion).toBeNull();
  });

  it('a failing feedback request never breaks the action', async () => {
    const { result, sendText, feedback } = await withSuggestion();
    feedback.mockRejectedValue(new Error('cloudcli is down'));
    act(() => result.current.send('Run pnpm verify.'));
    expect(sendText).toHaveBeenCalled();
    expect(result.current.suggestion).toBeNull();
  });
});

describe('write_notes and handoff run through Foreman', () => {
  const executed = (result: Record<string, unknown>) => ({ ok: true, json: async () => ({ success: true, data: { ok: true, result } }) }) as unknown as Response;
  const failed = (message: string) => ({ ok: false, status: 502, json: async () => ({ success: false, error: { code: 'FOREMAN_EXECUTE_FAILED', message } }) }) as unknown as Response;

  async function withExecutable(action: 'write_notes' | 'handoff') {
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(make({}, { action, message: undefined, reason: 'Rule says so' })));
    const view = setup();
    await waitFor(() => expect(view.result.current.suggestion).not.toBeNull());
    return view;
  }

  it('plans both as execute', async () => {
    expect((await withExecutable('write_notes')).result.current.plan).toEqual({ kind: 'execute', action: 'write_notes', text: 'Rule says so' });
    expect((await withExecutable('handoff')).result.current.plan).toEqual({ kind: 'execute', action: 'handoff', text: 'Rule says so' });
  });

  it('write_notes: runs the action, keeps the card to report the version, and does not send or report feedback itself', async () => {
    const execute = vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ version: 3, chars: 2400 }));
    const feedback = vi.spyOn(api.foreman, 'suggestionFeedback').mockResolvedValue(ok());
    const { result, sendText, openSession } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    expect(execute).toHaveBeenCalledWith('sug_1');
    expect(result.current.execution).toMatchObject({ phase: 'done', action: 'write_notes', notesVersion: 3 });
    expect(feedback).not.toHaveBeenCalled(); // Foreman marks it sent itself
    expect(sendText).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(result.current.card).not.toBeNull();
  });

  it('the card survives Foreman pushing the suggestion as sent, and a late pending fetch does not bring the old card back', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ version: 3 }));
    const { result } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ status: 'sent' }, { action: 'write_notes', reason: 'x' }) });
    expect(result.current.suggestion).toBeNull();
    expect(result.current.card?.suggestion.id).toBe('sug_1');
    expect(result.current.execution?.phase).toBe('done');
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ status: 'pending' }, { action: 'write_notes', reason: 'x' }) });
    expect(result.current.suggestion).toBeNull();
  });

  it('while it runs the card is in the running phase, and the push of the answered suggestion does not drop it', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.spyOn(api.foreman, 'executeSuggestion').mockReturnValue(new Promise<Response>(resolve => (release = resolve)));
    const { result } = await withExecutable('handoff');
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.execute();
    });
    expect(result.current.execution?.phase).toBe('running');
    await bus.emit({ kind: 'foreman_suggestion', sessionId: 'session-1', suggestion: make({ status: 'sent' }, { action: 'handoff', reason: 'x' }) });
    expect(result.current.card).not.toBeNull();
    await act(async () => {
      release(executed({ newSessionId: 'new-9' }));
      await pending;
    });
    expect(result.current.execution).toMatchObject({ phase: 'done', newSessionId: 'new-9' });
  });

  it('handoff: opens the fresh session it created', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ newSessionId: 'new-session-9', handoffId: 'ho_1' }));
    const { result, openSession } = await withExecutable('handoff');
    await act(async () => result.current.execute());
    expect(openSession).toHaveBeenCalledWith('new-session-9');
    expect(result.current.execution).toMatchObject({ phase: 'done', action: 'handoff', newSessionId: 'new-session-9' });
  });

  it('a failure keeps the suggestion pending with the reason, and pressing again retries', async () => {
    const execute = vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValueOnce(failed('UNKNOWN_PROJECT')).mockResolvedValueOnce(executed({ newSessionId: 'new-1' }));
    const { result, openSession } = await withExecutable('handoff');
    await act(async () => result.current.execute());
    expect(result.current.execution).toMatchObject({ phase: 'failed', error: 'UNKNOWN_PROJECT' });
    expect(result.current.suggestion?.id).toBe('sug_1');
    expect(openSession).not.toHaveBeenCalled();
    await act(async () => result.current.execute());
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.current.execution?.phase).toBe('done');
  });

  it('a request that throws is a failure with its message', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockRejectedValue(new Error('network down'));
    const { result } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    expect(result.current.execution).toMatchObject({ phase: 'failed', error: 'network down' });
  });

  it('view notes loads them through the user route; hide folds them; closing the card clears everything', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ version: 3 }));
    const notes = vi.spyOn(api.foreman, 'notes').mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { notes: { content: '# Task notes', version: 3, turn: 4, createdAt: 't' } } }) } as unknown as Response);
    const { result } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    expect(result.current.notesView.phase).toBe('closed');
    await act(async () => result.current.viewNotes());
    expect(notes).toHaveBeenCalledWith('session-1');
    expect(result.current.notesView).toMatchObject({ phase: 'ready', notes: { content: '# Task notes', version: 3 } });
    act(() => result.current.hideNotes());
    expect(result.current.notesView.phase).toBe('closed');
    await act(async () => result.current.viewNotes());
    act(() => result.current.closeExecution());
    expect(result.current.execution).toBeNull();
    expect(result.current.card).toBeNull();
    expect(result.current.notesView.phase).toBe('closed');
  });

  it('view notes reports none, and a failed request', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ version: 3 }));
    const notes = vi.spyOn(api.foreman, 'notes').mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { notes: null } }) } as unknown as Response);
    const { result } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    await act(async () => result.current.viewNotes());
    expect(result.current.notesView.phase).toBe('empty');
    notes.mockRejectedValue(new Error('down'));
    await act(async () => result.current.viewNotes());
    expect(result.current.notesView.phase).toBe('failed');
  });

  it('the finished card belongs to its session: another chat never shows it', async () => {
    vi.spyOn(api.foreman, 'executeSuggestion').mockResolvedValue(executed({ version: 3 }));
    const { result, rerender } = await withExecutable('write_notes');
    await act(async () => result.current.execute());
    expect(result.current.card).not.toBeNull();
    vi.spyOn(api.foreman, 'pendingSuggestion').mockResolvedValue(pendingResponse(null));
    rerender({ sessionId: 'session-2', enabled: true, currentModel: 'sonnet' });
    expect(result.current.card).toBeNull();
    rerender({ sessionId: 'session-1', enabled: true, currentModel: 'sonnet' });
    expect(result.current.card).not.toBeNull();
  });
});

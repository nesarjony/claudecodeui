import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import {
  isForemanSuggestion,
  planSuggestion,
  type ForemanExecution,
  type ForemanFeedbackAction,
  type ForemanNotes,
  type ForemanNotesView,
  type ForemanSuggestion,
  type SuggestionPlan,
} from '@/modules/chat/foreman/foremanSuggestion';

type UseForemanSuggestionOptions = {
  /** The session whose suggestion to show; null on a brand-new chat. */
  sessionId: string | null;
  /** The per-user "show Foreman suggestions" preference. Off: nothing is fetched and nothing is shown. */
  enabled: boolean;
  /** The composer's current model, to tell whether a suggested model switch is a change. */
  currentModel: string | null;
  /** Sends text through the normal chat send path, exactly as if the user typed it. */
  sendText: (text: string) => void;
  /** Puts text in the composer for the user to edit. */
  fillComposer: (text: string) => void;
  /** The existing model switch path (the composer's model picker). */
  switchModel: (model: string) => Promise<void> | void;
  /** Opens a session in the chat (the app's own navigation); used to land on the fresh session a handoff created. */
  openSession?: (sessionId: string) => void;
  /**
   * Filled with a function the composer calls with the text of every message the user submits, so an edited
   * suggestion can be reported with what was finally sent.
   */
  submitListenerRef: { current: ((text: string) => void) | null };
};

type FeedbackBody = { action: ForemanFeedbackAction; finalText?: string };

/**
 * State and actions behind the "Foreman suggests" card.
 *
 * It loads the session's pending suggestion when the chat opens, follows `foreman_suggestion` frames from the chat
 * WebSocket (a newer suggestion replaces the card; a superseded or answered one removes it), and reports what the
 * user does with each suggestion back to Foreman through cloudcli, which stores it as feedback on the decision trace.
 */
export function useForemanSuggestion({
  sessionId,
  enabled,
  currentModel,
  sendText,
  fillComposer,
  switchModel,
  openSession,
  submitListenerRef,
}: UseForemanSuggestionOptions) {
  const { subscribe } = useWebSocket();
  // The suggestion on show, together with the session it belongs to. Deriving what is shown from the pair (instead of
  // clearing state in an effect when the session changes) means a card for the previous session can never render, not
  // even for one frame.
  const [held, setHeld] = useState<{ sessionId: string; suggestion: ForemanSuggestion } | null>(null);
  const suggestion = enabled && held && held.sessionId === sessionId ? held.suggestion : null;
  // The last press of "Write the notes now" or "Hand off", with a snapshot of its suggestion: Foreman marks the suggestion
  // sent when the action works, which would remove the card, but the card has to stay to say what was done. Tied to its
  // session the same way as `held`, so it never shows on another chat.
  const [executionState, setExecutionState] = useState<ForemanExecution | null>(null);
  const execution = enabled && executionState && executionState.suggestion.sessionId === sessionId ? executionState : null;
  // The notes panel: closed until the user asks to view the notes, then the request's progress and result.
  const [notesView, setNotesView] = useState<ForemanNotesView>({ phase: 'closed' });
  // Suggestions that left the pending state, so a slow initial fetch cannot bring one back.
  const settledIdsRef = useRef(new Set<string>());
  // A suggestion the user pressed Edit on: the next message they send is reported as its outcome.
  const editingRef = useRef<{ id: string; sessionId: string; initialText: string } | null>(null);
  const sessionIdRef = useRef(sessionId);
  // Counts the suggestion frames applied so far: a fetch that started before a push must not undo that push.
  const appliedSeqRef = useRef(0);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    settledIdsRef.current = new Set();
    editingRef.current = null;
    setNotesView({ phase: 'closed' });
  }, [sessionId, enabled]);

  const report = useCallback((id: string, body: FeedbackBody) => {
    // The message and the report leave together; a failed report is only a missing data point.
    void api.foreman.suggestionFeedback(id, body).catch(() => undefined);
  }, []);

  const apply = useCallback((incoming: ForemanSuggestion) => {
    appliedSeqRef.current += 1;
    if (incoming.status === 'pending') {
      if (settledIdsRef.current.has(incoming.id)) return;
      setHeld({ sessionId: incoming.sessionId, suggestion: incoming });
      return;
    }
    settledIdsRef.current.add(incoming.id);
    setHeld((current) => (current?.suggestion.id === incoming.id ? null : current));
  }, []);

  // The pending suggestion for this session, fetched when the chat opens, when the preference is switched on, and
  // after the socket reconnects. "None pending" clears what is shown (it may have been superseded while we could not
  // hear about it), unless a push arrived while the request was in flight.
  const fetchPending = useCallback(async () => {
    if (!enabled || !sessionId) return;
    const seqAtStart = appliedSeqRef.current;
    try {
      const response = await api.foreman.pendingSuggestion(sessionId);
      if (!response.ok) return;
      const payload = await response.json();
      const incoming: unknown = payload?.data?.suggestion;
      if (sessionIdRef.current !== sessionId) return;
      if (isForemanSuggestion(incoming)) {
        if (incoming.sessionId === sessionId) apply(incoming);
      } else if (incoming === null && appliedSeqRef.current === seqAtStart) {
        setHeld((current) => (current?.sessionId === sessionId ? null : current));
      }
    } catch {
      // Foreman or cloudcli unreachable: no card, nothing else to do.
    }
  }, [apply, enabled, sessionId]);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribe((event) => {
      if (event.kind === 'websocket_reconnected') {
        void fetchPending();
        return;
      }
      if (event.kind !== 'foreman_suggestion' || event.sessionId !== sessionIdRef.current) return;
      if (isForemanSuggestion(event.suggestion)) apply(event.suggestion);
    });
  }, [apply, enabled, fetchPending, subscribe]);

  const plan: SuggestionPlan | null = useMemo(
    () => (suggestion ? planSuggestion(suggestion, { currentModel }) : null),
    [currentModel, suggestion],
  );

  const settle = useCallback((id: string) => {
    settledIdsRef.current.add(id);
    setHeld((current) => (current?.suggestion.id === id ? null : current));
  }, []);

  /** Send: the message goes through the normal send path, and the suggestion is reported as used as it was. */
  const send = useCallback((text: string) => {
    if (!suggestion) return;
    report(suggestion.id, { action: 'sent' });
    settle(suggestion.id);
    sendText(text);
  }, [report, sendText, settle, suggestion]);

  /** Edit: the text goes to the composer; what the user finally sends is reported against this suggestion. */
  const edit = useCallback((text: string) => {
    if (!suggestion) return;
    editingRef.current = { id: suggestion.id, sessionId: suggestion.sessionId, initialText: text };
    settle(suggestion.id);
    fillComposer(text);
  }, [fillComposer, settle, suggestion]);

  /** Dismiss: report it and remove the card. */
  const dismiss = useCallback(() => {
    if (!suggestion) return;
    report(suggestion.id, { action: 'dismissed' });
    settle(suggestion.id);
  }, [report, settle, suggestion]);

  /** Switch to the suggested model through the existing model switch path; the suggestion counts as used. */
  const switchTo = useCallback((model: string) => {
    if (!suggestion) return;
    report(suggestion.id, { action: 'sent' });
    settle(suggestion.id);
    void Promise.resolve(switchModel(model)).catch(() => undefined);
  }, [report, settle, suggestion, switchModel]);

  /**
   * Execute: has Foreman do a write_notes or handoff suggestion itself. While it works the card shows progress; on success a
   * write_notes card says which notes version was written (and offers to show it) and a handoff opens the fresh session; on
   * failure the suggestion stays pending with the reason, so the button can be pressed again.
   */
  const execute = useCallback(async () => {
    if (!suggestion || plan?.kind !== 'execute') return;
    const { action } = plan;
    const base = { suggestion, action };
    setExecutionState({ ...base, phase: 'running' });
    setNotesView({ phase: 'closed' });
    try {
      const response = await api.foreman.executeSuggestion(suggestion.id);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      }
      const result = payload.data?.result ?? {};
      // Foreman answered it (marked it sent): the pending card goes, and a late pending fetch must not bring it back.
      settle(suggestion.id);
      const newSessionId = typeof result.newSessionId === 'string' ? result.newSessionId : undefined;
      setExecutionState({ ...base, phase: 'done', notesVersion: typeof result.version === 'number' ? result.version : undefined, newSessionId });
      if (action === 'handoff' && newSessionId) openSession?.(newSessionId);
    } catch (error) {
      setExecutionState({ ...base, phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }, [openSession, plan, settle, suggestion]);

  /** Loads the notes into the card's panel through the signed-in user's route (the bridge token stays server-side). */
  const viewNotes = useCallback(async () => {
    const target = sessionIdRef.current;
    if (!target) return;
    setNotesView({ phase: 'loading' });
    try {
      const response = await api.foreman.notes(target);
      const payload = await response.json().catch(() => null);
      if (sessionIdRef.current !== target) return;
      if (!response.ok || !payload?.success) {
        setNotesView({ phase: 'failed' });
        return;
      }
      const notes: ForemanNotes | null = payload.data?.notes ?? null;
      setNotesView(notes && typeof notes.content === 'string' ? { phase: 'ready', notes } : { phase: 'empty' });
    } catch {
      setNotesView({ phase: 'failed' });
    }
  }, []);

  const hideNotes = useCallback(() => setNotesView({ phase: 'closed' }), []);

  /** Closes the card that reports what Foreman did (it has already been answered, so there is nothing to report back). */
  const closeExecution = useCallback(() => {
    setExecutionState(null);
    setNotesView({ phase: 'closed' });
  }, []);

  // The composer tells us every message the user submits. If it follows an Edit, report it: `edited` with the final
  // text, or `sent` when the user pressed Edit and then sent the text unchanged.
  useEffect(() => {
    submitListenerRef.current = (text: string) => {
      const editing = editingRef.current;
      if (!editing || editing.sessionId !== sessionIdRef.current) return;
      editingRef.current = null;
      const finalText = text.trim();
      if (!finalText) return;
      report(editing.id, finalText === editing.initialText.trim() ? { action: 'sent' } : { action: 'edited', finalText });
    };
    return () => {
      submitListenerRef.current = null;
    };
  }, [report, submitListenerRef]);

  // What the card shows: the pending suggestion, or (after Write notes / Hand off) the snapshot of the one that was just carried out.
  const card = useMemo<{ suggestion: ForemanSuggestion; plan: SuggestionPlan } | null>(() => {
    if (suggestion && plan) return { suggestion, plan };
    if (!execution) return null;
    return { suggestion: execution.suggestion, plan: { kind: 'execute', action: execution.action, text: execution.suggestion.decision.decision.reason } };
  }, [execution, plan, suggestion]);

  return { suggestion, plan, card, send, edit, dismiss, switchTo, execution, notesView, execute, viewNotes, hideNotes, closeExecution };
}

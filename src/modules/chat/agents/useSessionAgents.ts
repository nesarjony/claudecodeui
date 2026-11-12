import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '@/shared/api';

export type AgentStatus = 'running' | 'done' | 'interrupted' | 'cut-off' | 'failed' | 'empty';

export type AgentActivity = { tool: string; target: string; at: string | null };

export type SessionAgent = {
  agentId: string;
  taskId: string | null;
  toolUseId: string | null;
  name: string | null;
  description: string;
  agentType: string | null;
  background: boolean;
  status: AgentStatus;
  model: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  durationMs: number;
  toolUses: number;
  lastTool: AgentActivity | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  costKnown: boolean;
  prompt: string;
  result: string;
  activity: AgentActivity[];
};

export type SessionAgents = {
  sessionId: string;
  stretchStartedAt: string | null;
  earlierCount: number;
  includesEarlier: boolean;
  model: string | null;
  apiKeyBilled: boolean;
  totals: { running: number; done: number; unfinished: number; costUsd: number };
  agents: SessionAgent[];
};

// Transcripts are re-read while anything is running; otherwise a slow refresh
// is enough to notice agents started from elsewhere.
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 20000;

/**
 * Polls the subagents of one session's current working stretch (agents from
 * before its last long pause only with `includeEarlier`). Each chat pane holds
 * its own copy.
 */
export function useSessionAgents(sessionId: string | null, isProcessing: boolean, includeEarlier = false) {
  const [data, setData] = useState<SessionAgents | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const request = ++requestRef.current;
    try {
      const res = await authenticatedFetch(
        `/api/agents/${encodeURIComponent(sessionId)}${includeEarlier ? '?all=1' : ''}`,
      );
      if (!res.ok || request !== requestRef.current) return;
      setData((await res.json()) as SessionAgents);
    } catch {
      // Keep showing the last snapshot; the next poll retries.
    }
  }, [sessionId, includeEarlier]);

  // A different session must never show the previous one's agents.
  useEffect(() => {
    setData(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = isProcessing || (data?.totals.running ?? 0) > 0;
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => void refresh(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, active, refresh]);

  const stopAgent = useCallback(
    async (taskId: string) => {
      if (!sessionId) return false;
      const res = await authenticatedFetch(
        `/api/agents/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`,
        { method: 'POST' },
      );
      void refresh();
      return res.ok;
    },
    [sessionId, refresh],
  );

  return { data, refresh, stopAgent };
}

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

export type BackgroundShellStatus = 'running' | 'done' | 'failed' | 'stopped';

/** A Bash command run in (or moved to) the background, or a Monitor watch. */
export type BackgroundShell = {
  taskId: string;
  toolUseId: string | null;
  kind: 'shell' | 'monitor';
  description: string;
  command: string;
  status: BackgroundShellStatus;
  summary: string | null;
  exitCode: number | null;
  movedToBackground: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  outputTail: string[];
};

export type SessionAgents = {
  sessionId: string;
  sessionName: string | null;
  stretchStartedAt: string | null;
  earlierCount: number;
  includesEarlier: boolean;
  model: string | null;
  apiKeyBilled: boolean;
  totals: { running: number; done: number; unfinished: number; costUsd: number };
  agents: SessionAgent[];
  background: BackgroundShell[];
};

// Transcripts are re-read while anything is running; otherwise a slow refresh
// is enough to notice agents started from elsewhere.
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 20000;

/**
 * Polls the subagents and background shells of one session's current working
 * stretch (agents from before its last long pause only with `includeEarlier`).
 * Each chat pane holds its own copy; `watching` (a panel showing live output is
 * open) polls at the fast rate.
 */
export function useSessionAgents(sessionId: string | null, isProcessing: boolean, includeEarlier = false, watching = false) {
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

  const active =
    isProcessing ||
    watching ||
    (data?.totals.running ?? 0) > 0 ||
    (data?.background ?? []).some((shell) => shell.status === 'running');
  useEffect(() => {
    if (!sessionId) return;
    // Look again soon after the pace changes: a turn that just ended may have
    // left background work running, and an opened panel wants fresh output.
    const soon = setTimeout(() => void refresh(), 500);
    const timer = setInterval(() => void refresh(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => {
      clearTimeout(soon);
      clearInterval(timer);
    };
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

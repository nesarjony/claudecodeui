import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Loader2,
  PauseCircle,
  RotateCw,
  Square,
  X,
  XCircle,
} from 'lucide-react';

import {
  useSessionAgents,
  type AgentStatus,
  type SessionAgent,
  type SessionAgents,
} from '@/modules/chat/agents/useSessionAgents';
import { useChatHeaderSlot } from '@/modules/chat/agents/ChatHeaderStatus';

type AgentsBarProps = {
  sessionId: string | null;
  isProcessing: boolean;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};

const UNFINISHED: AgentStatus[] = ['interrupted', 'cut-off', 'failed'];

const STATUS: Record<AgentStatus, { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  running: { label: 'Running', icon: Loader2, tone: 'text-primary' },
  done: { label: 'Done', icon: CheckCircle2, tone: 'text-emerald-500' },
  interrupted: { label: 'Interrupted', icon: PauseCircle, tone: 'text-amber-500' },
  'cut-off': { label: 'Cut off', icon: AlertTriangle, tone: 'text-amber-500' },
  failed: { label: 'Failed', icon: XCircle, tone: 'text-red-500' },
  empty: { label: 'Not started', icon: CircleDashed, tone: 'text-muted-foreground' },
};

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function formatTokens(agent: SessionAgent): string {
  const total = agent.tokens.input + agent.tokens.output + agent.tokens.cacheRead + agent.tokens.cacheWrite;
  if (total >= 1e6) return `${(total / 1e6).toFixed(1)}M`;
  if (total >= 1e3) return `${Math.round(total / 1e3)}k`;
  return String(total);
}

function formatCost(usd: number, known: boolean, apiKeyBilled: boolean): string {
  if (!known) return '—';
  const amount = usd >= 10 ? usd.toFixed(1) : usd.toFixed(2);
  return `${apiKeyBilled ? '' : '≈'}$${amount}`;
}

function agentTitle(agent: SessionAgent): string {
  return agent.name ? `${agent.name} · ${agent.description}` : agent.description || agent.agentId;
}

function shortModel(model: string | null): string {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-(\d)-(\d)/, ' $1.$2').replace(/-(\d)$/, ' $1');
}

function StatusIcon({ status, className = 'h-4 w-4' }: { status: AgentStatus; className?: string }) {
  const { icon: Icon, tone } = STATUS[status];
  return <Icon className={`${className} shrink-0 ${tone} ${status === 'running' ? 'animate-spin' : ''}`} />;
}

const resumePrompt = (agent: SessionAgent) =>
  `Use the SendMessage tool to resume the subagent with agent ID ${agent.agentId}` +
  `${agent.name ? ` (${agent.name})` : ''}. Address it by that ID, not by name. Message it: ` +
  '"Continue exactly where you left off and finish your original task." Let it run in the background.';

/**
 * Subagents of one chat session: a one-line summary above the transcript that
 * opens a panel (bottom sheet on phones, side drawer on desktop) listing every
 * agent with live status, tool use, tokens and cost, plus stop and resume.
 */
function AgentsBar({ sessionId, isProcessing, setInput, onSubmit }: AgentsBarProps) {
  const [open, setOpen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // In a header with a status slot the summary is a compact chip there,
  // so it costs the transcript no row; otherwise it is a row of its own.
  const headerSlot = useChatHeaderSlot(anchorRef, 'data-chat-header-status');
  const { data, stopAgent } = useSessionAgents(sessionId, isProcessing, showEarlier);
  const isDesktop = useMediaQuery('(min-width: 640px)');

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Earlier agents are fetched only while the panel is open and asks for them.
  useEffect(() => {
    if (!open) setShowEarlier(false);
  }, [open]);

  const currentCount = data ? data.agents.length - (data.includesEarlier ? data.earlierCount : 0) : 0;
  if (!data || currentCount === 0) return <span ref={anchorRef} hidden />;
  const { totals, apiKeyBilled } = data;
  const anyCostKnown = data.agents.some((agent) => agent.costKnown);

  const resume = (agent: SessionAgent) => {
    setInput(resumePrompt(agent));
    setOpen(false);
    setTimeout(
      () => onSubmit?.({ preventDefault: () => undefined } as unknown as React.FormEvent<HTMLFormElement>),
      0,
    );
  };

  const chip = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open agents panel"
      title="Agents in this session"
      className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2 text-[11px] font-medium tabular-nums text-foreground transition hover:bg-muted"
    >
      <Bot className="h-3 w-3 text-primary" />
      {totals.running > 0 && (
        <span className="flex items-center gap-0.5 text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {totals.running}
        </span>
      )}
      {totals.done > 0 && (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          {totals.done}
        </span>
      )}
      {totals.unfinished > 0 && (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <PauseCircle className="h-3 w-3 text-amber-500" />
          {totals.unfinished}
        </span>
      )}
      <span className="hidden sm:inline">{formatCost(totals.costUsd, anyCostKnown, apiKeyBilled)}</span>
    </button>
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {headerSlot ? createPortal(chip, headerSlot) : (
      <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full flex-shrink-0 items-center gap-2 border-b border-border/50 bg-card/60 px-3 py-2 text-left text-xs transition hover:bg-muted/60"
          aria-label="Open agents panel"
        >
          <Bot className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-semibold text-foreground">Agents</span>
          {totals.running > 0 && (
            <span className="flex items-center gap-1 text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> {totals.running} running
            </span>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" /> {totals.done}
          </span>
          {totals.unfinished > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <PauseCircle className="h-3 w-3 text-amber-500" /> {totals.unfinished}
            </span>
          )}
          <span className="ml-auto font-medium tabular-nums text-foreground">
            {formatCost(totals.costUsd, anyCostKnown, apiKeyBilled)}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      )}

      {open &&
        createPortal(
          <AgentsPanel
            data={data}
            isDesktop={isDesktop}
            onClose={() => setOpen(false)}
            onStop={stopAgent}
            onResume={resume}
            onShowEarlier={() => setShowEarlier(true)}
          />,
          document.body,
        )}
    </>
  );
}

type AgentsPanelProps = {
  data: SessionAgents;
  isDesktop: boolean;
  onClose: () => void;
  onStop: (taskId: string) => Promise<boolean>;
  onResume: (agent: SessionAgent) => void;
  onShowEarlier: () => void;
};

function AgentsPanel({ data, isDesktop, onClose, onStop, onResume, onShowEarlier }: AgentsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data.agents.find((agent) => agent.agentId === selectedId) ?? null;

  const stretchStart = data.stretchStartedAt ?? '';
  const isEarlier = (agent: SessionAgent) =>
    data.includesEarlier && agent.status !== 'running' && (agent.lastActivityAt ?? '') < stretchStart;

  const byRecent = (a: SessionAgent, b: SessionAgent) =>
    (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
  const current = useMemo(
    () => data.agents.filter((agent) => !isEarlier(agent)).sort(byRecent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );
  const earlier = useMemo(
    () => data.agents.filter(isEarlier).sort(byRecent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );
  const groups: Array<{ key: string; title: string; tone: string; agents: SessionAgent[] }> = [
    { key: 'running', title: 'Running', tone: 'text-primary', agents: current.filter((a) => a.status === 'running') },
    { key: 'finished', title: 'Finished', tone: 'text-emerald-500', agents: current.filter((a) => a.status === 'done') },
    {
      key: 'failed',
      title: 'Failed',
      tone: 'text-amber-500',
      agents: current.filter((a) => a.status !== 'running' && a.status !== 'done'),
    },
  ];

  const renderCard = (agent: SessionAgent) => (
    <AgentCard
      key={agent.agentId}
      agent={agent}
      apiKeyBilled={data.apiKeyBilled}
      onOpen={() => setSelectedId(agent.agentId)}
      onStop={onStop}
      onResume={onResume}
    />
  );

  return (
    <>
      <div className="fixed inset-0 z-[160] bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="Agents"
        className={
          isDesktop
            ? 'fixed inset-y-0 right-0 z-[161] flex w-[28rem] max-w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-2xl'
            : 'fixed inset-x-0 bottom-0 z-[161] flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-border bg-popover pb-safe-area-inset-bottom text-popover-foreground shadow-2xl'
        }
      >
        {!isDesktop && (
          <div className="flex shrink-0 justify-center pt-2" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}

        {selected ? (
          <AgentDetail
            agent={selected}
            apiKeyBilled={data.apiKeyBilled}
            onBack={() => setSelectedId(null)}
            onClose={onClose}
            onStop={onStop}
            onResume={onResume}
          />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
              <Bot className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Agents</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatCost(data.totals.costUsd, data.agents.some((a) => a.costKnown), data.apiKeyBilled)}
                {!data.apiKeyBilled && ' API-equivalent'}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2">
              {groups
                .filter((group) => group.agents.length > 0)
                .map((group) => (
                  <section key={group.key} className="space-y-1.5 pb-2">
                    <h3 className="flex items-center gap-1.5 px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span className={group.tone}>{group.title}</span>
                      <span className="tabular-nums">{group.agents.length}</span>
                    </h3>
                    {group.agents.map(renderCard)}
                  </section>
                ))}
              {current.length === 0 && (
                <p className="px-2 py-8 text-center text-sm text-muted-foreground">No agents in this stretch.</p>
              )}
              {earlier.length > 0 && (
                <section className="space-y-1.5 pb-2">
                  <h3 className="flex items-center gap-1.5 px-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Earlier in this session <span className="tabular-nums">{earlier.length}</span>
                  </h3>
                  {earlier.map(renderCard)}
                </section>
              )}
              {!data.includesEarlier && data.earlierCount > 0 && (
                <button
                  type="button"
                  onClick={onShowEarlier}
                  className="mt-2 flex h-10 w-full items-center justify-center rounded-lg text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground sm:h-8"
                >
                  Show {data.earlierCount} earlier agent{data.earlierCount === 1 ? '' : 's'} from this session
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

type AgentActionsProps = {
  agent: SessionAgent;
  onStop: (taskId: string) => Promise<boolean>;
  onResume: (agent: SessionAgent) => void;
  large?: boolean;
};

function AgentActions({ agent, onStop, onResume, large = false }: AgentActionsProps) {
  const [stopping, setStopping] = useState(false);
  const size = large ? 'h-10 px-4 text-sm' : 'h-9 px-3 text-xs sm:h-7';
  if (agent.status === 'running' && agent.taskId) {
    const taskId = agent.taskId;
    return (
      <button
        type="button"
        disabled={stopping}
        onClick={async (event) => {
          event.stopPropagation();
          setStopping(true);
          await onStop(taskId);
          setStopping(false);
        }}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 font-medium text-foreground transition hover:border-red-500/60 hover:text-red-500 disabled:opacity-50 ${size}`}
      >
        <Square className="h-3.5 w-3.5" /> {stopping ? 'Stopping…' : 'Stop'}
      </button>
    );
  }
  if (UNFINISHED.includes(agent.status)) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onResume(agent);
        }}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 font-medium text-foreground transition hover:bg-primary/20 ${size}`}
      >
        <RotateCw className="h-3.5 w-3.5" /> Resume
      </button>
    );
  }
  return null;
}

type AgentCardProps = {
  agent: SessionAgent;
  apiKeyBilled: boolean;
  onOpen: () => void;
  onStop: (taskId: string) => Promise<boolean>;
  onResume: (agent: SessionAgent) => void;
};

function AgentCard({ agent, apiKeyBilled, onOpen, onStop, onResume }: AgentCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
      className={
        'cursor-pointer rounded-xl border p-3 transition hover:bg-muted/50 ' +
        (agent.status === 'running' ? 'border-primary/40 bg-primary/[0.04]' : 'border-border/60 bg-card/40')
      }
    >
      <div className="flex items-start gap-2">
        <StatusIcon status={agent.status} className="mt-0.5 h-4 w-4" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium text-foreground">{agentTitle(agent)}</div>
          {agent.lastTool && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {agent.lastTool.tool}
              {agent.lastTool.target ? ` · ${agent.lastTool.target}` : ''}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(agent.durationMs)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-6 text-[11px] tabular-nums text-muted-foreground">
        <span className="whitespace-nowrap">{formatTokens(agent)} tok</span>
        <span className="whitespace-nowrap">{agent.toolUses} tools</span>
        {agent.model && <span className="max-w-[8rem] truncate">{shortModel(agent.model)}</span>}
        <span className="ml-auto flex items-center gap-2">
          <span className="whitespace-nowrap font-medium text-foreground">
            {formatCost(agent.costUsd, agent.costKnown, apiKeyBilled)}
          </span>
          <AgentActions agent={agent} onStop={onStop} onResume={onResume} />
        </span>
      </div>
    </div>
  );
}

type AgentDetailProps = {
  agent: SessionAgent;
  apiKeyBilled: boolean;
  onBack: () => void;
  onClose: () => void;
  onStop: (taskId: string) => Promise<boolean>;
  onResume: (agent: SessionAgent) => void;
};

function AgentDetail({ agent, apiKeyBilled, onBack, onClose, onStop, onResume }: AgentDetailProps) {
  const [promptOpen, setPromptOpen] = useState(false);
  const timeline = [...agent.activity].reverse();
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-1 py-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <StatusIcon status={agent.status} />
        <span className="ml-1 text-xs font-medium text-muted-foreground">{STATUS[agent.status].label}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{agentTitle(agent)}</h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
            {agent.agentType && <span>{agent.agentType}</span>}
            {agent.model && <span>{shortModel(agent.model)}</span>}
            <span>{formatDuration(agent.durationMs)}</span>
            <span>{formatTokens(agent)} tok</span>
            <span>{agent.toolUses} tools</span>
            <span className="font-medium text-foreground">{formatCost(agent.costUsd, agent.costKnown, apiKeyBilled)}</span>
            {agent.background && <span>background</span>}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">{agent.agentId}</div>
        </div>

        <section className="rounded-lg border border-border/60">
          <button
            type="button"
            onClick={() => setPromptOpen((value) => !value)}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Prompt
            <ChevronRight className={`h-3.5 w-3.5 transition ${promptOpen ? 'rotate-90' : ''}`} />
          </button>
          {promptOpen && (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-sans text-xs text-foreground">
              {agent.prompt}
            </pre>
          )}
        </section>

        {agent.status === 'done' && agent.result && (
          <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2">
            <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Result</div>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground">{agent.result}</p>
          </section>
        )}

        <section>
          <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Activity {agent.activity.length > 0 && <span className="normal-case tracking-normal">(latest first)</span>}
          </div>
          <ol className="space-y-1">
            {timeline.map((item, index) => (
              <li key={`${item.at}-${index}`} className="flex gap-2 text-xs">
                <span className="w-11 shrink-0 tabular-nums text-muted-foreground">
                  {item.at ? new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                </span>
                <span className="shrink-0 font-medium text-foreground">{item.tool}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{item.target}</span>
              </li>
            ))}
            {timeline.length === 0 && <li className="text-xs text-muted-foreground">No tool calls yet.</li>}
          </ol>
        </section>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 p-2">
        <AgentActions agent={agent} onStop={onStop} onResume={onResume} large />
      </div>
    </>
  );
}

export default memo(AgentsBar);

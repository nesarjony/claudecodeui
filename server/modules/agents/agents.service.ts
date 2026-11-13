import { promises as fs } from 'node:fs';
import path from 'node:path';

import { listBackgroundShells, type BackgroundShell } from '@/modules/agents/background-shells.service.js';
import { sessionsDb } from '@/modules/database/index.js';
import { getLiveAgentTasks, getLiveBackgroundTasks } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

export type AgentStatus = 'running' | 'done' | 'interrupted' | 'cut-off' | 'failed' | 'empty';

export type AgentActivity = { tool: string; target: string; at: string | null };

export type AgentSummary = {
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
  /** False when no message used a model with a known price (e.g. routed to MiniMax). */
  costKnown: boolean;
  prompt: string;
  result: string;
  activity: AgentActivity[];
};

export type SessionAgents = {
  sessionId: string;
  sessionName: string | null;
  /** Start of the session's current working stretch (after its last long pause). */
  stretchStartedAt: string | null;
  /** Agents last active before the current stretch; listed only when asked for. */
  earlierCount: number;
  includesEarlier: boolean;
  model: string | null;
  apiKeyBilled: boolean;
  totals: { running: number; done: number; unfinished: number; costUsd: number };
  agents: AgentSummary[];
  /** Background shells and monitors of the current stretch, running first. */
  background: BackgroundShell[];
};

type Price = { input: number; output: number; cacheRead: number };

// $ per million tokens (Anthropic first-party API rates). Cache writes are
// priced from input: 1.25x for the 5-minute cache, 2x for the 1-hour cache.
const PRICES: Array<[string, Price]> = [
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4', { input: 5, output: 25, cacheRead: 0.5 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['haiku-4', { input: 1, output: 5, cacheRead: 0.1 }],
];

// An agent whose transcript changed this recently is treated as still running
// when the live task registry has no word on it (e.g. after a server restart).
const RECENT_ACTIVITY_MS = 30_000;
const MAX_ACTIVITY_ROWS = 60;
// A pause this long with no activity in the main transcript ends a working
// stretch; agents from before it belong to earlier work in the same session.
const STRETCH_GAP_MS = 2 * 60 * 60 * 1000;
// Only the transcript's tail is scanned for that pause; a stretch longer than
// this much transcript simply starts at the oldest entry read.
const STRETCH_SCAN_BYTES = 8 * 1024 * 1024;

function priceFor(model: string | null): Price | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  return PRICES.find(([key]) => normalized.includes(key))?.[1] ?? null;
}

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

function costOf(usage: Usage, price: Price | null): number {
  if (!price) return 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write1h);
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      write5m * price.input * 1.25 +
      write1h * price.input * 2) /
    1_000_000
  );
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown };
type Entry = {
  type?: string;
  timestamp?: string;
  message?: { id?: string; model?: string; usage?: Usage; stop_reason?: string | null; content?: unknown };
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 140);
  }
  return '';
}

async function readJsonl(file: string): Promise<Entry[]> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  const entries: Entry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // A line being written right now; the next poll reads it whole.
    }
  }
  return entries;
}

async function summarizeAgent(file: string, live: ReturnType<typeof getLiveAgentTasks>): Promise<AgentSummary> {
  const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
  const meta = await fs
    .readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({} as Record<string, unknown>));
  const [entries, stat] = await Promise.all([readJsonl(file), fs.stat(file)]);
  const turns = entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant');

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  let costKnown = false;
  let model: string | null = null;
  let toolUses = 0;
  let result = '';
  const activity: AgentActivity[] = [];
  // One API response is written as one entry per content block, each repeating
  // the response's usage, so usage is counted once per message id.
  const countedMessages = new Set<string>();

  for (const entry of turns) {
    if (entry.type !== 'assistant') continue;
    const message = entry.message ?? {};
    if (message.model && !message.model.startsWith('<')) model = message.model;
    const messageKey = message.id ?? `${entry.timestamp}`;
    if (message.usage && !countedMessages.has(messageKey)) {
      countedMessages.add(messageKey);
      const usage = message.usage;
      tokens.input += usage.input_tokens ?? 0;
      tokens.output += usage.output_tokens ?? 0;
      tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      const price = priceFor(message.model ?? model);
      if (price) costKnown = true;
      costUsd += costOf(usage, price);
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content as Block[]) {
        if (block?.type === 'tool_use') {
          toolUses += 1;
          activity.push({ tool: block.name ?? 'tool', target: toolTarget(block.input), at: entry.timestamp ?? null });
        } else if (block?.type === 'text' && block.text?.trim()) {
          result = block.text;
        }
      }
    }
  }

  let status: AgentStatus;
  if (turns.length === 0) {
    status = 'empty';
  } else {
    const last = turns[turns.length - 1];
    const content = last.message?.content;
    const kinds = Array.isArray(content) ? (content as Block[]).map((block) => block?.type) : ['text'];
    if (last.type === 'user' && textOf(content).startsWith('[Request interrupted')) status = 'interrupted';
    else if (last.type === 'assistant' && !kinds.includes('tool_use') && last.message?.stop_reason !== 'tool_use') status = 'done';
    else status = 'cut-off';
  }

  const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
  const liveTask = toolUseId ? live.get(toolUseId) : undefined;
  if (liveTask?.status === 'running') status = 'running';
  else if (liveTask?.status === 'failed') status = 'failed';
  else if (!liveTask && status === 'cut-off' && Date.now() - stat.mtimeMs < RECENT_ACTIVITY_MS) status = 'running';

  const startedAt = turns[0]?.timestamp ?? null;
  const lastActivityAt = turns[turns.length - 1]?.timestamp ?? null;
  const endMs = status === 'running' ? Date.now() : lastActivityAt ? Date.parse(lastActivityAt) : 0;

  return {
    agentId,
    taskId: liveTask?.taskId ?? null,
    toolUseId,
    name: typeof meta.name === 'string' ? meta.name : null,
    description: typeof meta.description === 'string' ? meta.description : textOf(turns[0]?.message?.content).slice(0, 80),
    agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
    background: meta.requestShape === 'background',
    status,
    model,
    startedAt,
    lastActivityAt,
    durationMs: startedAt && endMs ? Math.max(0, endMs - Date.parse(startedAt)) : 0,
    toolUses,
    lastTool: activity[activity.length - 1] ?? null,
    tokens,
    costUsd,
    costKnown,
    prompt: textOf(turns[0]?.message?.content).slice(0, 4000),
    result: result.slice(0, 4000),
    activity: activity.slice(-MAX_ACTIVITY_ROWS),
  };
}

/** Whole lines of the main transcript's tail, oldest first. */
async function readTranscriptTail(jsonlPath: string): Promise<string[]> {
  const handle = await fs.open(jsonlPath, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, STRETCH_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift(); // first line is cut mid-way
    return lines;
  } finally {
    await handle.close();
  }
}

/** Start time of the main transcript's current stretch, from its tail's timestamps. */
function findStretchStart(lines: string[]): number | null {
  const times: number[] = [];
  for (const line of lines) {
    const match = /"timestamp":"([^"]+)"/.exec(line);
    const time = match ? Date.parse(match[1]) : NaN;
    if (!Number.isNaN(time)) times.push(time);
  }
  if (times.length === 0) return null;
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] >= STRETCH_GAP_MS) return times[i];
  }
  return times[0];
}

/**
 * Subagents and background shells of one cloudcli session, read from the
 * provider's transcript folder. By default only agents active in the session's
 * current working stretch (and any still running) are read; `includeEarlier`
 * adds the rest. Background shells are always the current stretch's.
 */
export async function listSessionAgents(sessionId: string, includeEarlier = false): Promise<SessionAgents> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) throw new AppError('Session not found.', { statusCode: 404 });
  const jsonlPath = session.jsonl_path;
  const sessionModel = session.model ?? null;
  const agentsDir = jsonlPath ? path.join(jsonlPath.replace(/\.jsonl$/, ''), 'subagents') : null;
  const files = agentsDir
    ? (await fs.readdir(agentsDir).catch(() => [] as string[]))
        .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
        .map((name) => path.join(agentsDir, name))
    : [];

  const live = getLiveAgentTasks(sessionId);
  const tail = jsonlPath ? await readTranscriptTail(jsonlPath) : [];
  const stretchStart = findStretchStart(tail);
  const runningToolUseIds = new Set(
    [...live.entries()].filter(([, task]) => task.status === 'running').map(([toolUseId]) => toolUseId),
  );
  const mtimes = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.mtimeMs).catch(() => 0)));
  // Running agents always count as current; their tool_use id is in their metadata.
  const runningFiles = new Set<string>();
  if (runningToolUseIds.size > 0) {
    await Promise.all(files.map(async (file) => {
      const meta = await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => '');
      const match = /"toolUseId":"([^"]+)"/.exec(meta);
      if (match && runningToolUseIds.has(match[1])) runningFiles.add(file);
    }));
  }
  const isCurrent = (file: string, index: number) =>
    stretchStart === null || mtimes[index] >= stretchStart || runningFiles.has(file);
  const selected = files.filter((file, index) => includeEarlier || isCurrent(file, index));
  const earlierCount = files.filter((file, index) => !isCurrent(file, index)).length;

  const agents = (await Promise.all(selected.map((file) => summarizeAgent(file, live)))).sort((a, b) =>
    (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
  );
  // Totals describe the current stretch even when earlier agents are listed.
  const current = includeEarlier
    ? agents.filter((agent) => {
        const index = files.findIndex((file) => file.endsWith(`agent-${agent.agentId}.jsonl`));
        return index >= 0 && isCurrent(files[index], index);
      })
    : agents;

  const liveBackground = getLiveBackgroundTasks(sessionId);
  const background = jsonlPath
    ? await listBackgroundShells({
        jsonlPath,
        lines: tail,
        stretchStart,
        live: {
          liveTaskIds: liveBackground ? new Set(liveBackground.map((task) => task.taskId)) : null,
          tracked: new Map([...live.values()].map((task) => [task.taskId, task.status])),
        },
      })
    : [];

  return {
    sessionId,
    sessionName: session.custom_name ?? null,
    stretchStartedAt: stretchStart ? new Date(stretchStart).toISOString() : null,
    earlierCount,
    includesEarlier: includeEarlier,
    model: sessionModel,
    apiKeyBilled: Boolean(sessionModel?.endsWith('@api')),
    totals: {
      running: current.filter((agent) => agent.status === 'running').length,
      done: current.filter((agent) => agent.status === 'done').length,
      unfinished: current.filter((agent) => agent.status === 'interrupted' || agent.status === 'cut-off' || agent.status === 'failed').length,
      costUsd: current.reduce((sum, agent) => sum + agent.costUsd, 0),
    },
    agents,
    background,
  };
}

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clipText, summarizeToolInput } from '@/shared/utils.js';

type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Caps that keep a digest small enough for a supervisor model to read in one go.
const MAX_USER_MESSAGE = 2000;
const MAX_ASSISTANT_TEXT = 4000;
const MAX_TURN_SUMMARY_TEXT = 500;
const MAX_TOOL_INPUT = 200;
const MAX_TOOL_CALLS_LISTED = 60;
const MAX_FILES_LISTED = 50;
const MAX_TODOS_LISTED = 40;
const MAX_TODO_TEXT = 200;
const MAX_REFUSAL_EXPLANATION = 300;

// The transcript is read from its end, widening until enough turns are in view.
const INITIAL_TAIL_BYTES = 1024 * 1024;
const MAX_TAIL_BYTES = 32 * 1024 * 1024;

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** One parsed transcript line. Transcript rows are loosely typed JSON; readers narrow field by field. */
export type TranscriptEntry = RecordValue;

export type DigestToolCall = { name: string; shortInput: string; isError: boolean };
export type DigestTodo = { content: string; status: string };
export type DigestCompactBoundary = {
  at: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
};
export type DigestTurnSummary = {
  userMessage: string | null;
  assistantText: string | null;
  toolCallCount: number;
  stopReason: string | null;
};

/** Condensed view of the last N turns of one session transcript. */
export type SessionDigestBody = {
  turnsRequested: number;
  turnsIncluded: number;
  /** True when the transcript was cut at its start before `turnsRequested` turns were found. */
  transcriptTruncated: boolean;
  lastUserMessage: string | null;
  /** `user`, `task-notification`, `peer` or `command` (a slash command such as /compact). */
  lastUserMessageKind: string | null;
  finalAssistantText: string | null;
  toolCalls: DigestToolCall[];
  toolCallCount: number;
  toolErrorCount: number;
  toolCounts: Record<string, number>;
  filesEdited: string[];
  filesEditedCount: number;
  todos: DigestTodo[] | null;
  /** Stop reason of the final assistant message; null while it is still streaming. */
  stopReason: string | null;
  refusal: boolean;
  refusalDetail: { category: string | null; explanation: string | null } | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Prompt size of the last main-thread request, the best read of the live context. */
    contextTokens: number | null;
    /** Session cost last reported by the CLI (cumulative for that CLI process); null when none was written. */
    costUsdReported: number | null;
  };
  compactBoundaries: DigestCompactBoundary[];
  apiErrorCount: number;
  startedAt: string | null;
  endedAt: string | null;
  turns: DigestTurnSummary[];
};

type AssistantMessageRecord = {
  id: string;
  model: string | null;
  texts: string[];
  stopReason: string | null;
  stopDetails: RecordValue | null;
  usage: RecordValue | null;
  at: string | null;
};

type ToolCallRecord = { id: string; name: string; input: RecordValue | null };

function isTurnStart(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) {
    return false;
  }
  const content = asRecord(entry.message)?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  const blocks = asArray(content).map(asRecord);
  const hasToolResult = blocks.some((block) => block?.type === 'tool_result');
  const hasText = blocks.some((block) => block?.type === 'text' && (asString(block.text) ?? '').trim().length > 0);
  return hasText && !hasToolResult;
}

function userText(entry: TranscriptEntry): string {
  const content = asRecord(entry.message)?.content;
  if (typeof content === 'string') {
    return content;
  }
  return asArray(content)
    .map(asRecord)
    .filter((block): block is RecordValue => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function userMessageKind(entry: TranscriptEntry, text: string): string {
  const origin = asString(asRecord(entry.origin)?.kind);
  if (origin === 'task-notification' || origin === 'peer') {
    return origin;
  }
  return text.trimStart().startsWith('<command-name>') ? 'command' : 'user';
}

/** Renders a slash-command echo (`<command-name>/compact</command-name>...`) as the command the sender typed. */
function readableUserText(text: string): string {
  const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) {
    return text;
  }
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function editedFilePath(call: ToolCallRecord): string | null {
  if (!FILE_EDIT_TOOLS.has(call.name) || !call.input) {
    return null;
  }
  return asString(call.input.file_path) ?? asString(call.input.notebook_path);
}

/**
 * Rebuilds the latest todo list from the transcript rows it was read from.
 *
 * Handles both generations of the tool: `TodoWrite` carries the whole list each time, while
 * `TaskCreate`/`TaskUpdate` mutate a list one task at a time (ids come from the create result).
 * Returns `null` when no todo tool was used in the rows given.
 */
function readLatestTodos(entries: TranscriptEntry[]): DigestTodo[] | null {
  let todoWrite: DigestTodo[] | null = null;
  const tasks = new Map<string, DigestTodo>();
  const pendingCreates = new Map<string, string>(); // tool_use id -> subject
  let sawTaskTools = false;

  for (const entry of entries) {
    if (entry.isSidechain === true) {
      continue;
    }
    const message = asRecord(entry.message);
    if (entry.type === 'assistant') {
      for (const block of asArray(message?.content).map(asRecord)) {
        if (block?.type !== 'tool_use') {
          continue;
        }
        const input = asRecord(block.input);
        if (block.name === 'TodoWrite') {
          todoWrite = asArray(input?.todos)
            .map(asRecord)
            .filter((todo): todo is RecordValue => todo !== null)
            .map((todo) => ({
              content: clipText(asString(todo.content) ?? asString(todo.activeForm) ?? '', MAX_TODO_TEXT),
              status: asString(todo.status) ?? 'pending',
            }));
          sawTaskTools = false;
          tasks.clear();
        } else if (block.name === 'TaskCreate') {
          sawTaskTools = true;
          pendingCreates.set(String(block.id), clipText(asString(input?.subject) ?? '', MAX_TODO_TEXT));
        } else if (block.name === 'TaskUpdate') {
          sawTaskTools = true;
          const taskId = String(input?.taskId ?? '');
          const status = asString(input?.status);
          const existing = tasks.get(taskId);
          if (status === 'deleted') {
            tasks.delete(taskId);
          } else if (taskId) {
            tasks.set(taskId, {
              content: asString(input?.subject) ? clipText(asString(input?.subject) ?? '', MAX_TODO_TEXT) : existing?.content ?? `task ${taskId}`,
              status: status ?? existing?.status ?? 'pending',
            });
          }
        }
      }
    } else if (entry.type === 'user' && pendingCreates.size > 0) {
      const created = asString(asRecord(asRecord(entry.toolUseResult)?.task)?.id);
      for (const block of asArray(message?.content).map(asRecord)) {
        const subject = block?.type === 'tool_result' ? pendingCreates.get(String(block.tool_use_id)) : undefined;
        if (subject !== undefined && created) {
          tasks.set(created, { content: subject, status: 'pending' });
          pendingCreates.delete(String(block?.tool_use_id));
        }
      }
    }
  }

  if (sawTaskTools && tasks.size > 0) {
    return [...tasks.values()].slice(0, MAX_TODOS_LISTED);
  }
  return todoWrite ? todoWrite.slice(0, MAX_TODOS_LISTED) : null;
}

/**
 * Builds the digest of the last `turns` turns from parsed transcript rows (oldest first).
 *
 * A turn starts at a real user row (typed text, a slash command, or a background-task
 * notification) and runs to the next one. Rows are read defensively: transcripts are written by
 * the CLI and gain fields over time, so anything unexpected is skipped rather than failing.
 * Pure and synchronous so it can be tested against fixture transcripts.
 */
// Consumed by foreman-sessions.service.ts (digest endpoint) and the digest tests.
export function buildSessionDigest(
  rows: TranscriptEntry[],
  options: { turns: number; truncatedHead?: boolean },
): SessionDigestBody {
  const entries = rows.filter((entry) => entry.isSidechain !== true);
  const turnStarts: number[] = [];
  entries.forEach((entry, index) => {
    if (isTurnStart(entry)) {
      turnStarts.push(index);
    }
  });

  const windowStart = turnStarts.length > 0 ? turnStarts[Math.max(0, turnStarts.length - options.turns)] : 0;
  const turnsIncluded = turnStarts.filter((index) => index >= windowStart).length;
  const windowEntries = entries.slice(windowStart);

  const assistantById = new Map<string, AssistantMessageRecord>();
  const assistantOrder: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const toolResultErrors = new Map<string, boolean>();
  const compactBoundaries: DigestCompactBoundary[] = [];
  let refusalDetail: { category: string | null; explanation: string | null } | null = null;
  let apiErrorCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastUser: { text: string; kind: string } | null = null;
  const turnSummaries: Array<{ user: string | null; assistantIds: string[]; calls: number }> = [];
  let anonymousId = 0;

  for (const entry of windowEntries) {
    const timestamp = asString(entry.timestamp);
    if (timestamp) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }

    if (isTurnStart(entry)) {
      const rawText = userText(entry);
      lastUser = { text: readableUserText(rawText), kind: userMessageKind(entry, rawText) };
      turnSummaries.push({ user: lastUser.text, assistantIds: [], calls: 0 });
      continue;
    }

    if (entry.type === 'assistant') {
      const message = asRecord(entry.message);
      if (!message) {
        continue;
      }
      const model = asString(message.model);
      // Placeholders the CLI writes for local API-error rows ("<synthetic>") are not real responses.
      if (model?.startsWith('<')) {
        continue;
      }
      const id = asString(message.id) ?? `anonymous-${(anonymousId += 1)}`;
      let record = assistantById.get(id);
      if (!record) {
        record = { id, model, texts: [], stopReason: null, stopDetails: null, usage: null, at: timestamp };
        assistantById.set(id, record);
        assistantOrder.push(id);
        turnSummaries[turnSummaries.length - 1]?.assistantIds.push(id);
      }
      // One API response is written as several rows (one per content block), each repeating the
      // response-level fields; the last row seen carries the final stop reason and usage.
      record.stopReason = asString(message.stop_reason) ?? record.stopReason;
      record.stopDetails = asRecord(message.stop_details) ?? record.stopDetails;
      record.usage = asRecord(message.usage) ?? record.usage;
      for (const block of asArray(message.content).map(asRecord)) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          record.texts.push(block.text);
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id),
            name: asString(block.name) ?? 'tool',
            input: asRecord(block.input),
          });
          const summary = turnSummaries[turnSummaries.length - 1];
          if (summary) {
            summary.calls += 1;
          }
        }
      }
      continue;
    }

    if (entry.type === 'user') {
      for (const block of asArray(asRecord(entry.message)?.content).map(asRecord)) {
        if (block?.type === 'tool_result') {
          toolResultErrors.set(String(block.tool_use_id), block.is_error === true);
        }
      }
      continue;
    }

    if (entry.type === 'system') {
      const subtype = asString(entry.subtype);
      if (subtype === 'compact_boundary') {
        const metadata = asRecord(entry.compactMetadata) ?? asRecord(entry.compact_metadata);
        compactBoundaries.push({
          at: timestamp,
          trigger: asString(metadata?.trigger),
          preTokens: asNumber(metadata?.preTokens ?? metadata?.pre_tokens),
          postTokens: asNumber(metadata?.postTokens ?? metadata?.post_tokens),
        });
      } else if (subtype === 'model_refusal_no_fallback' || subtype === 'model_refusal_fallback') {
        const explanation = asString(entry.apiRefusalExplanation) ?? asString(entry.api_refusal_explanation);
        refusalDetail = {
          category: asString(entry.apiRefusalCategory) ?? asString(entry.api_refusal_category),
          explanation: explanation ? clipText(explanation, MAX_REFUSAL_EXPLANATION) : null,
        };
      } else if (subtype === 'api_error') {
        apiErrorCount += 1;
      }
    }
  }

  const assistantMessages = assistantOrder.map((id) => assistantById.get(id) as AssistantMessageRecord);
  const textOf = (message: AssistantMessageRecord) => message.texts.join('\n').trim();

  const finalText = [...assistantMessages].reverse().map(textOf).find((text) => text.length > 0) ?? null;
  const lastAssistant = assistantMessages[assistantMessages.length - 1] ?? null;

  const refusedMessage = assistantMessages.find((message) => message.stopReason === 'refusal') ?? null;
  const refused = refusedMessage !== null || refusalDetail !== null;
  if (refusedMessage && !refusalDetail) {
    const explanation = asString(refusedMessage.stopDetails?.explanation);
    refusalDetail = {
      category: asString(refusedMessage.stopDetails?.category),
      explanation: explanation ? clipText(explanation, MAX_REFUSAL_EXPLANATION) : null,
    };
  }

  const toolCounts: Record<string, number> = {};
  let toolErrorCount = 0;
  const callList: DigestToolCall[] = toolCalls.map((call) => {
    toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
    const isError = toolResultErrors.get(call.id) === true;
    if (isError) {
      toolErrorCount += 1;
    }
    return { name: call.name, shortInput: summarizeToolInput(call.input, MAX_TOOL_INPUT), isError };
  });

  const filesEdited: string[] = [];
  for (const call of toolCalls) {
    const file = editedFilePath(call);
    if (file && toolResultErrors.get(call.id) !== true && !filesEdited.includes(file)) {
      filesEdited.push(file);
    }
  }

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const message of assistantMessages) {
    usage.inputTokens += asNumber(message.usage?.input_tokens) ?? 0;
    usage.outputTokens += asNumber(message.usage?.output_tokens) ?? 0;
    usage.cacheReadTokens += asNumber(message.usage?.cache_read_input_tokens) ?? 0;
    usage.cacheCreationTokens += asNumber(message.usage?.cache_creation_input_tokens) ?? 0;
  }

  const lastCostState = [...rows].reverse().find((entry) => entry.type === 'cost-state');

  return {
    turnsRequested: options.turns,
    turnsIncluded,
    transcriptTruncated: Boolean(options.truncatedHead) && turnStarts.length < options.turns,
    lastUserMessage: lastUser ? clipText(lastUser.text, MAX_USER_MESSAGE) : null,
    lastUserMessageKind: lastUser?.kind ?? null,
    finalAssistantText: finalText ? clipText(finalText, MAX_ASSISTANT_TEXT) : null,
    toolCalls: callList.slice(-MAX_TOOL_CALLS_LISTED),
    toolCallCount: callList.length,
    toolErrorCount,
    toolCounts,
    filesEdited: filesEdited.slice(0, MAX_FILES_LISTED),
    filesEditedCount: filesEdited.length,
    todos: readLatestTodos(rows),
    stopReason: lastAssistant?.stopReason ?? null,
    refusal: refused,
    refusalDetail: refused ? refusalDetail : null,
    usage: {
      ...usage,
      contextTokens: lastAssistant && lastAssistant.usage ? promptTokens(lastAssistant.usage) : null,
      costUsdReported: asNumber(lastCostState?.totalCostUSD),
    },
    compactBoundaries,
    apiErrorCount,
    startedAt,
    endedAt,
    turns: turnSummaries.slice(-options.turns).map((summary) => {
      const messages = summary.assistantIds.map((id) => assistantById.get(id) as AssistantMessageRecord);
      const text = [...messages].reverse().map(textOf).find((value) => value.length > 0) ?? null;
      return {
        userMessage: summary.user ? clipText(summary.user, MAX_TURN_SUMMARY_TEXT) : null,
        assistantText: text ? clipText(text, MAX_TURN_SUMMARY_TEXT) : null,
        toolCallCount: summary.calls,
        stopReason: messages[messages.length - 1]?.stopReason ?? null,
      };
    }),
  };
}

/** Prompt size of one request: everything the model was sent, cached or not. */
function promptTokens(usage: RecordValue): number {
  return (asNumber(usage.input_tokens) ?? 0)
    + (asNumber(usage.cache_read_input_tokens) ?? 0)
    + (asNumber(usage.cache_creation_input_tokens) ?? 0);
}

/** Context usage read from a transcript's last main-thread assistant message. */
export type TranscriptContextEstimate = {
  usedTokens: number;
  /** `assistant_usage` = prompt plus output of the last request; `compact_boundary` = size right after a compaction. */
  basis: 'assistant_usage' | 'compact_boundary';
  at: string | null;
};

/**
 * Estimates how full the context is from transcript rows alone, for sessions with no live process.
 *
 * Scans backwards: a compaction boundary seen before any later assistant message means the
 * context was just rebuilt, so its recorded post-compaction size is used; otherwise the last
 * real assistant message's prompt plus output tokens (what the next request will carry).
 */
// Consumed by foreman-sessions.service.ts for the context endpoint's fallback.
export function estimateContextFromTranscript(rows: TranscriptEntry[]): TranscriptContextEstimate | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index];
    if (entry.isSidechain === true) {
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const metadata = asRecord(entry.compactMetadata) ?? asRecord(entry.compact_metadata);
      const post = asNumber(metadata?.postTokens ?? metadata?.post_tokens);
      return post === null ? null : { usedTokens: post, basis: 'compact_boundary', at: asString(entry.timestamp) };
    }
    if (entry.type === 'assistant') {
      const message = asRecord(entry.message);
      const usage = asRecord(message?.usage);
      if (!usage || asString(message?.model)?.startsWith('<')) {
        continue;
      }
      const used = promptTokens(usage) + (asNumber(usage.output_tokens) ?? 0);
      if (used > 0) {
        return { usedTokens: used, basis: 'assistant_usage', at: asString(entry.timestamp) };
      }
    }
  }
  return null;
}

/** Parses JSONL text, skipping blank lines and lines that are not whole JSON objects (e.g. one being written). */
// Consumed by readTranscriptTail below and by the digest tests.
export function parseTranscriptLines(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed) {
        entries.push(parsed);
      }
    } catch {
      // A partial line at the very end of a live transcript; the next read sees it whole.
    }
  }
  return entries;
}

/** Reads the last `bytes` of a transcript as parsed rows; `truncatedHead` is true when the start was left out. */
async function readTranscriptBytes(file: string, bytes: number): Promise<{ rows: TranscriptEntry[]; truncatedHead: boolean } | null> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    const truncatedHead = length < size;
    if (truncatedHead) {
      lines.shift(); // cut mid-line
    }
    return { rows: parseTranscriptLines(lines.join('\n')), truncatedHead };
  } finally {
    await handle.close();
  }
}

/**
 * Reads transcript rows from the end of the file, doubling the window (up to 32 MiB) until
 * `isEnough` accepts them or the whole file has been read. Returns `null` when the file is unreadable.
 */
// Consumed by foreman-sessions.service.ts for digests and context estimates.
export async function readTranscriptRows(
  file: string,
  isEnough: (rows: TranscriptEntry[]) => boolean,
): Promise<{ rows: TranscriptEntry[]; truncatedHead: boolean } | null> {
  let bytes = INITIAL_TAIL_BYTES;
  for (;;) {
    const result = await readTranscriptBytes(file, bytes);
    if (!result) {
      return null;
    }
    if (!result.truncatedHead || isEnough(result.rows) || bytes >= MAX_TAIL_BYTES) {
      return result;
    }
    bytes *= 2;
  }
}

/** True when `rows` contain at least `turns` turn starts. */
// Consumed by foreman-sessions.service.ts as the widening condition for digest reads.
export function hasTurnStarts(rows: TranscriptEntry[], turns: number): boolean {
  let count = 0;
  for (const entry of rows) {
    if (entry.isSidechain !== true && isTurnStart(entry)) {
      count += 1;
      if (count >= turns) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Finds a session's transcript file: the indexed `jsonl_path` when it exists, otherwise a scan of
 * `~/.claude/projects/*` for `<providerSessionId>.jsonl` (brand-new sessions are not indexed yet).
 */
// Consumed by foreman-sessions.service.ts to locate the transcript behind a session row.
export async function locateTranscript(
  session: { jsonl_path: string | null; provider_session_id: string | null },
  projectsRoot: string = path.join(os.homedir(), '.claude', 'projects'),
): Promise<string | null> {
  if (session.jsonl_path && await fs.stat(session.jsonl_path).then((stat) => stat.isFile()).catch(() => false)) {
    return session.jsonl_path;
  }
  const providerId = session.provider_session_id;
  if (!providerId || !/^[A-Za-z0-9._-]+$/.test(providerId)) {
    return null;
  }
  const directories = await fs.readdir(projectsRoot).catch(() => [] as string[]);
  for (const directory of directories) {
    const candidate = path.join(projectsRoot, directory, `${providerId}.jsonl`);
    if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

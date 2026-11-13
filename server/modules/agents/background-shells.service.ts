import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BackgroundShellStatus = 'running' | 'done' | 'failed' | 'stopped';

export type BackgroundShell = {
  taskId: string;
  toolUseId: string | null;
  /** `shell` for a Bash command run in (or moved to) the background, `monitor` for a Monitor watch. */
  kind: 'shell' | 'monitor';
  description: string;
  command: string;
  status: BackgroundShellStatus;
  /** The CLI's one-line report of how it ended, once it has reported. */
  summary: string | null;
  exitCode: number | null;
  /** A foreground command that outran its timeout and was moved to the background. */
  movedToBackground: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  /** Last few non-empty lines of its output file. */
  outputTail: string[];
};

/** What the main transcript says about one background task. */
export type ShellRecord = {
  taskId: string;
  toolUseId: string | null;
  kind: 'shell' | 'monitor';
  description: string;
  command: string;
  movedToBackground: boolean;
  startedAt: string | null;
  outputPath: string | null;
  ended: { status: string; summary: string; at: string | null } | null;
};

/** How the CLI closed a task's output file: `[exited with code N]` or `[killed]`. */
export type OutputEnd = { killed: boolean; exitCode: number | null };

/** What the task's output file says: when it was last written and whether it was closed. */
export type OutputState = { mtimeMs: number | null; end: OutputEnd | null };

/** What this server's runtime knows about the session's tasks right now. */
export type ShellLiveState = {
  /** Task ids the session's live CLI process reports; null when no process of this server runs it. */
  liveTaskIds: Set<string> | null;
  /** Last task event the runtime saw per task id (`running`, `finished` or `failed`). */
  tracked: Map<string, string>;
};

// An output file written this recently counts as a running shell when no
// process of this server runs the session (e.g. a CLI run from a terminal).
const RECENT_OUTPUT_MS = 30_000;
const OUTPUT_TAIL_BYTES = 4096;
const OUTPUT_TAIL_LINES = 5;
const MAX_LINE_CHARS = 240;
const MAX_COMMAND_CHARS = 1000;
// Task ids are short and alphanumeric (`bc02ck9lv`); anything else is never
// joined into a path.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ORPHANED_SUMMARY = "didn't finish before the previous session ended";
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string };
type Entry = {
  type?: string;
  operation?: string;
  content?: unknown;
  timestamp?: string;
  toolUseResult?: Record<string, unknown>;
  message?: { content?: unknown };
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function tagValues(text: string, tag: string): string[] {
  return [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => match[1].trim());
}

/** The task id a tool_result reports for a background Bash command or a Monitor, if any. */
function startedTaskId(name: string | undefined, result: Record<string, unknown> | undefined, text: string): string | null {
  if (typeof result?.backgroundTaskId === 'string') return result.backgroundTaskId;
  const isMonitor = name === 'Monitor' || (!name && text.startsWith('Monitor started'));
  if (!isMonitor) return null;
  if (typeof result?.taskId === 'string') return result.taskId;
  return /^Monitor started \(task ([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
}

/**
 * Background shells and monitors started in a transcript, with how each ended
 * when the CLI has reported it (a `<task-notification>`, queued or delivered).
 * `lines` are raw JSONL lines in file order; lines that cannot matter are
 * skipped before parsing.
 */
export function parseBackgroundShells(lines: string[]): ShellRecord[] {
  const toolUses = new Map<string, Block>();
  const records = new Map<string, ShellRecord>();
  const endings = new Map<string, NonNullable<ShellRecord['ended']>>();

  for (const line of lines) {
    if (
      !line.includes('"name":"Bash"') &&
      !line.includes('"name":"Monitor"') &&
      !line.includes('backgroundTaskId') &&
      !line.includes('Monitor started') &&
      !line.includes('<task-notification>')
    ) {
      continue;
    }
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a line being written right now; the next poll reads it whole
    }
    const timestamp = entry.timestamp ?? null;

    // Notifications are written when queued and again when delivered; the
    // first is closest to when the task really ended.
    const notice =
      entry.type === 'queue-operation' && entry.operation === 'enqueue'
        ? textOf(entry.content)
        : entry.type === 'user'
          ? textOf(entry.message?.content)
          : '';
    if (notice.includes('<task-notification>')) {
      const [status] = tagValues(notice, 'status');
      // Monitor events carry no status; they are not endings.
      if (status) {
        const summary = tagValues(notice, 'summary')[0] ?? '';
        for (const taskId of tagValues(notice, 'task-id')) {
          // Ids starting with "__" are the CLI's internal scan markers.
          if (!taskId.startsWith('__') && !endings.has(taskId)) endings.set(taskId, { status, summary, at: timestamp });
        }
      }
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block?.type === 'tool_use' && block.id && (block.name === 'Bash' || block.name === 'Monitor')) {
        toolUses.set(block.id, block);
      } else if (block?.type === 'tool_result' && block.tool_use_id) {
        const use = toolUses.get(block.tool_use_id);
        const text = textOf(block.content);
        const taskId = startedTaskId(use?.name, entry.toolUseResult, text);
        if (!taskId || records.has(taskId)) continue;
        const input = use?.input ?? {};
        const description = typeof input.description === 'string' ? input.description.trim() : '';
        const command = typeof input.command === 'string' ? input.command.slice(0, MAX_COMMAND_CHARS) : '';
        records.set(taskId, {
          taskId,
          toolUseId: block.tool_use_id,
          kind: use?.name === 'Monitor' || text.startsWith('Monitor started') ? 'monitor' : 'shell',
          description,
          command,
          movedToBackground: typeof entry.toolUseResult?.timedOutAfterMs === 'number',
          startedAt: timestamp,
          outputPath: /Output is being written to: (\S+?\.output)\b/.exec(text)?.[1] ?? null,
          ended: null,
        });
      }
    }
  }

  return [...records.values()].map((record) => {
    const ended = endings.get(record.taskId) ?? null;
    // Without the tool call in the scanned tail, the report still names it.
    const described = record.description || /^(?:Background command|Monitor) "(.+)" /.exec(ended?.summary ?? '')?.[1] || '';
    return { ...record, description: described, ended };
  });
}

/** Exit code named in a CLI report such as `completed (exit code 0)` or `failed with exit code 2`. */
export function exitCodeOf(summary: string | null): number | null {
  // The last mention wins: the quoted description before it may say "exit" too.
  const match = [...(summary ?? '').matchAll(/exit(?: code)? (-?\d+)/g)].pop();
  return match ? Number(match[1]) : null;
}

/**
 * Current status of one background task: the CLI's own report when it has
 * made one, else what this server's live process says, else how the CLI
 * closed its output file (a stop from the UI or a teardown leaves no report),
 * else a guess from whether that file is still being written.
 */
export function resolveShellStatus(
  record: ShellRecord,
  live: ShellLiveState,
  output: OutputState,
  now: number,
): { status: BackgroundShellStatus; endedAt: string | null } {
  const outputMtimeMs = output.mtimeMs;
  const lastWrite = outputMtimeMs !== null ? new Date(outputMtimeMs).toISOString() : null;
  if (record.ended) {
    const reported = record.ended.status;
    const status: BackgroundShellStatus = reported === 'completed' ? 'done' : reported === 'failed' ? 'failed' : 'stopped';
    // A task orphaned by an earlier process is only reported when the session
    // resumes; its last output is the better guess at when it really ended.
    const orphaned = record.ended.summary.includes(ORPHANED_SUMMARY);
    return { status, endedAt: orphaned ? lastWrite : record.ended.at };
  }
  if (live.liveTaskIds?.has(record.taskId)) return { status: 'running', endedAt: null };
  if (output.end) {
    const status: BackgroundShellStatus = output.end.killed ? 'stopped' : output.end.exitCode === 0 ? 'done' : 'failed';
    return { status, endedAt: lastWrite };
  }
  const tracked = live.tracked.get(record.taskId);
  if (tracked === 'finished') return { status: 'done', endedAt: lastWrite };
  if (tracked === 'failed') return { status: 'failed', endedAt: lastWrite };
  // Seen starting by the live process but no longer listed: its report is
  // on its way into the transcript.
  if (tracked === 'running' && live.liveTaskIds) return { status: 'running', endedAt: null };
  if (outputMtimeMs !== null && now - outputMtimeMs < RECENT_OUTPUT_MS) return { status: 'running', endedAt: null };
  // No live process holds it and nothing writes to it: the process that ran
  // it is gone (the CLI reports such tasks as stopped when it resumes).
  return { status: 'stopped', endedAt: lastWrite };
}

/**
 * Last `count` non-empty lines of output text, as a terminal would show them:
 * escape sequences dropped and a `\r`-rewritten line reduced to its last state.
 */
export function tailLines(text: string, count = OUTPUT_TAIL_LINES, startsMidway = false): string[] {
  const lines = text.split('\n');
  if (startsMidway && lines.length > 1) lines.shift(); // first line is cut mid-way
  return lines
    .map((line) => line.split('\r').filter((part) => part.trim()).pop() ?? '')
    .map((line) => line.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '').trimEnd())
    .filter((line) => line.trim())
    .slice(-count)
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/**
 * Splits the CLI's closing line off output tail lines, so the tail shows only
 * what the command printed and the closing line feeds its status.
 */
export function splitOutputEnd(lines: string[]): { lines: string[]; end: OutputEnd | null } {
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (last === '[killed]') return { lines: lines.slice(0, -1), end: { killed: true, exitCode: null } };
  const exited = /^\[exited with code (-?\d+)\]$/.exec(last);
  if (exited) return { lines: lines.slice(0, -1), end: { killed: false, exitCode: Number(exited[1]) } };
  return { lines, end: null };
}

/** Directories Claude Code keeps task output under (`<tmp>/claude-<uid>/…/tasks/<id>.output`). */
async function taskOutputRoots(): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const tmpdirOverride = process.env.CLAUDE_CODE_TMPDIR;
  const candidates = [tmpdirOverride, os.tmpdir(), '/tmp']
    .filter((base): base is string => Boolean(base))
    .map((base) => path.join(base, `claude-${uid}`));
  if (tmpdirOverride) candidates.push(tmpdirOverride);
  const resolved = await Promise.all(candidates.map((candidate) => fs.realpath(candidate).catch(() => null)));
  return [...new Set(resolved.filter((root): root is string => Boolean(root)))];
}

/** True for a resolved path that is task `taskId`'s output file inside one of `roots`. */
export function isTaskOutputPath(realFile: string, taskId: string, roots: string[]): boolean {
  if (!TASK_ID_PATTERN.test(taskId)) return false;
  if (path.basename(realFile) !== `${taskId}.output`) return false;
  if (path.basename(path.dirname(realFile)) !== 'tasks') return false;
  return roots.some((root) => realFile.startsWith(root + path.sep));
}

/**
 * Tail, last-write time and closing line of a task's output file. The path
 * comes from transcript text, so only a regular file (never a symlink) that
 * resolves to Claude Code's own task output directory is read, and only its
 * last few KB.
 */
async function readOutputTail(
  candidates: string[],
  taskId: string,
  roots: string[],
): Promise<OutputState & { lines: string[] }> {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const info = await fs.lstat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !isTaskOutputPath(real, taskId, roots)) continue;
    const handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const length = Math.min(stat.size, OUTPUT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, stat.size - length);
      const { lines, end } = splitOutputEnd(tailLines(buffer.toString('utf8'), OUTPUT_TAIL_LINES + 1, length < stat.size));
      return { lines: lines.slice(-OUTPUT_TAIL_LINES), mtimeMs: stat.mtimeMs, end };
    } finally {
      await handle.close();
    }
  }
  return { lines: [], mtimeMs: null, end: null };
}

type ListOptions = {
  /** The session's main transcript (`<projects>/<project>/<providerSessionId>.jsonl`). */
  jsonlPath: string;
  /** Lines of that transcript's tail, oldest first. */
  lines: string[];
  /** Start of the session's current working stretch (ms), or null for all of it. */
  stretchStart: number | null;
  live: ShellLiveState;
  now?: number;
};

/**
 * Background shells and monitors of a session's current working stretch (and
 * any still running): running first, then the most recently active.
 */
export async function listBackgroundShells({ jsonlPath, lines, stretchStart, live, now = Date.now() }: ListOptions): Promise<BackgroundShell[]> {
  const records = parseBackgroundShells(lines);
  if (records.length === 0) return [];
  const roots = await taskOutputRoots();
  const projectDir = path.basename(path.dirname(jsonlPath));
  const providerSessionId = path.basename(jsonlPath, '.jsonl');

  const shells = await Promise.all(
    records.map(async (record): Promise<BackgroundShell> => {
      // Monitors do not print their output path; it sits beside the shells'.
      const derived = roots.map((root) => path.join(root, projectDir, providerSessionId, 'tasks', `${record.taskId}.output`));
      const candidates = TASK_ID_PATTERN.test(record.taskId)
        ? [...(record.outputPath ? [record.outputPath] : []), ...derived]
        : [];
      const output = await readOutputTail(candidates, record.taskId, roots);
      const { status, endedAt } = resolveShellStatus(record, live, output, now);
      const startMs = record.startedAt ? Date.parse(record.startedAt) : NaN;
      const endMs = status === 'running' ? now : endedAt ? Date.parse(endedAt) : NaN;
      return {
        taskId: record.taskId,
        toolUseId: record.toolUseId,
        kind: record.kind,
        description: record.description,
        command: record.command,
        status,
        summary: record.ended?.summary || null,
        exitCode: exitCodeOf(record.ended?.summary ?? null) ?? output.end?.exitCode ?? null,
        movedToBackground: record.movedToBackground,
        startedAt: record.startedAt,
        endedAt,
        durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
        outputTail: output.lines,
      };
    }),
  );

  const lastActive = (shell: BackgroundShell) => Date.parse(shell.endedAt ?? shell.startedAt ?? '') || 0;
  return shells
    .filter((shell) => shell.status === 'running' || stretchStart === null || lastActive(shell) >= stretchStart)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || lastActive(b) - lastActive(a));
}

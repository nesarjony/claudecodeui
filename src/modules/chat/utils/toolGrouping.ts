import type { ChatMessage, ToolGroupItem } from '@/shared/types';
import { formatToolDisplayName } from '@/modules/chat/tools/configs/toolConfigs';

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

/**
 * Tools that put something in front of the user to decide on — a question, a
 * plan to approve. Their cards stay in the transcript as rows of their own and
 * end the run of steps around them, so a fold can never hide what the agent is
 * waiting on.
 */
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

/**
 * True for a tool call that folds into a steps row. Subagent containers render
 * their own nested transcript and stay visible as their own rows.
 */
function isStepMessage(message: ChatMessage): boolean {
  return Boolean(
    message.isToolUse
    && message.toolName
    && !message.isSubagentContainer
    && !INTERACTIVE_TOOL_NAMES.has(message.toolName),
  );
}

/**
 * Folds every run of consecutive tool calls into one steps row.
 *
 * A run is broken by anything that reads as part of the conversation —
 * assistant text, a user turn, an error, a subagent, an interactive tool.
 * Reasoning that sits between two calls belongs to the run (Claude and Codex
 * both think between tool calls, and splitting on it would turn one run into a
 * dozen one-step rows); reasoning that leads into text stays outside it.
 *
 * Every run becomes a group, including a single call, so tool activity always
 * reads as the same kind of row.
 */
export function groupTranscriptSteps(messages: ChatMessage[]): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isStepMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    const steps: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      let lookahead = nextIndex;
      while (lookahead < messages.length && messages[lookahead].isThinking) {
        lookahead += 1;
      }

      if (lookahead >= messages.length || !isStepMessage(messages[lookahead])) {
        break;
      }

      for (let absorbed = nextIndex; absorbed <= lookahead; absorbed += 1) {
        run.push(messages[absorbed]);
      }
      steps.push(messages[lookahead]);
      nextIndex = lookahead + 1;
    }

    items.push({
      _isGroup: true,
      messages: run,
      steps,
      timestamp: message.timestamp,
    });
    index = nextIndex;
  }

  return items;
}

/**
 * Counts the transcript rows that come after `baseline`, the way the
 * transcript draws them: each run of steps is one row, reasoning is not
 * counted. Used for the "N new" count while the user reads back.
 *
 * The baseline is matched by identity first; a history refresh can replace the
 * row object with an equal one, so its timestamp is the fallback.
 */
export function countTranscriptRowsAfter(
  messages: ChatMessage[],
  baseline: { message: ChatMessage | null; time: number },
): number {
  let startIndex = baseline.message ? messages.lastIndexOf(baseline.message) : -1;
  if (startIndex < 0) {
    startIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const time = new Date(messages[index].timestamp).getTime();
      if (Number.isFinite(time) && time <= baseline.time) {
        startIndex = index;
        break;
      }
    }
  }

  return groupTranscriptSteps(messages.slice(startIndex + 1))
    .filter((item) => isToolGroupItem(item) || !item.isThinking)
    .length;
}

/* ------------------------------------------------------------------ */
/*  Step labels                                                        */
/* ------------------------------------------------------------------ */

type StepVerb = {
  /** Short name the steps summary counts by, e.g. "Read ×6 · Search ×4". */
  kind: string;
  /** Present tense, for the live current-step line. */
  active: string;
  /** Past tense, for a finished one-step row. */
  done: string;
  /** What the call operated on, from its parsed input. */
  target?: (input: Record<string, unknown>) => string;
};

const TARGET_MAX_LENGTH = 80;

function shorten(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > TARGET_MAX_LENGTH ? `${singleLine.slice(0, TARGET_MAX_LENGTH)}…` : singleLine;
}

function readString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

/**
 * A path as its last two segments: `implement-parity/SKILL.md`. The parent is
 * what tells two `index.ts` or `SKILL.md` edits apart on a phone-width line.
 */
function fileTarget(input: Record<string, unknown>): string {
  const path = readString(input, 'file_path', 'notebook_path', 'path', 'filePath');
  return shorten(path.split('/').filter(Boolean).slice(-2).join('/'));
}

function commandTarget(input: Record<string, unknown>): string {
  return shorten(readString(input, 'command', 'cmd').split('\n')[0] ?? '');
}

function quotedTarget(...keys: string[]) {
  return (input: Record<string, unknown>) => {
    const value = readString(input, ...keys);
    return value ? `"${shorten(value)}"` : '';
  };
}

function hostTarget(input: Record<string, unknown>): string {
  const url = readString(input, 'url');
  try {
    return new URL(url).host || shorten(url);
  } catch {
    return shorten(url);
  }
}

const FILE_EDIT_VERB: StepVerb = { kind: 'Edit', active: 'Editing', done: 'Edited', target: fileTarget };
const SHELL_VERB: StepVerb = { kind: 'Bash', active: 'Running', done: 'Ran', target: commandTarget };
const CHECKLIST_VERB: StepVerb = { kind: 'Checklist', active: 'Updating checklist', done: 'Updated checklist' };
const TASKS_VERB: StepVerb = { kind: 'Tasks', active: 'Updating tasks', done: 'Updated tasks' };

const STEP_VERBS: Record<string, StepVerb> = {
  Read: { kind: 'Read', active: 'Reading', done: 'Read', target: fileTarget },
  Edit: FILE_EDIT_VERB,
  MultiEdit: FILE_EDIT_VERB,
  ApplyPatch: FILE_EDIT_VERB,
  NotebookEdit: FILE_EDIT_VERB,
  Write: { kind: 'Write', active: 'Writing', done: 'Wrote', target: fileTarget },
  Bash: SHELL_VERB,
  PowerShell: SHELL_VERB,
  exec: SHELL_VERB,
  Grep: { kind: 'Search', active: 'Searching', done: 'Searched', target: quotedTarget('pattern') },
  Glob: { kind: 'Search', active: 'Finding', done: 'Found', target: quotedTarget('pattern') },
  ToolSearch: { kind: 'Search', active: 'Looking up tools', done: 'Looked up tools' },
  WebSearch: { kind: 'Web', active: 'Searching the web for', done: 'Searched the web for', target: quotedTarget('query') },
  WebFetch: { kind: 'Web', active: 'Fetching', done: 'Fetched', target: hostTarget },
  TodoWrite: CHECKLIST_VERB,
  TodoRead: CHECKLIST_VERB,
  TaskCreate: TASKS_VERB,
  TaskUpdate: TASKS_VERB,
  TaskList: TASKS_VERB,
  TaskGet: TASKS_VERB,
  Skill: { kind: 'Skill', active: 'Using skill', done: 'Used skill', target: (input) => shorten(readString(input, 'skill', 'command', 'name')) },
};

/** An MCP tool counts under its own name rather than "name (server)". */
function fallbackKind(toolName: string): string {
  return /^mcp__.+?__(.+)$/.exec(toolName)?.[1] ?? toolName;
}

function getStepVerb(toolName: string): StepVerb {
  const verb = STEP_VERBS[toolName];
  if (verb) {
    return verb;
  }

  const displayName = formatToolDisplayName(toolName);
  return { kind: fallbackKind(toolName), active: `Using ${displayName}`, done: `Used ${displayName}` };
}

function parseStepInput(toolInput: unknown): Record<string, unknown> {
  let parsed = toolInput;
  if (typeof toolInput === 'string') {
    try {
      parsed = JSON.parse(toolInput);
    } catch {
      // Still streaming in as partial JSON; the label goes without a target.
      return {};
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/** The kind a step counts under in the steps summary. Cheap: never parses input. */
export function getStepKind(message: ChatMessage): string {
  return getStepVerb(message.toolName || 'Tool').kind;
}

/**
 * A human label for one step — "Editing implement-parity/SKILL.md",
 * "Ran pnpm verify" — from the tool name and its key input.
 */
export function describeStep(message: ChatMessage, tense: 'active' | 'done'): string {
  const verb = getStepVerb(message.toolName || 'Tool');
  const target = verb.target?.(parseStepInput(message.toolInput)) ?? '';
  const action = tense === 'active' ? verb.active : verb.done;
  return target ? `${action} ${target}` : action;
}

/** True when a step's result came back as an error (including a denied permission). */
export function isFailedStep(message: ChatMessage): boolean {
  return Boolean(message.toolResult?.isError) || message.toolStatus === 'failed';
}

/** How many kinds the steps summary spells out before collapsing the rest into "+N". */
const SUMMARY_KIND_LIMIT = 3;

/**
 * "Read ×6 · Search ×4 · Bash" — counts per kind, most frequent first (ties
 * keep first-appearance order), the tail beyond three kinds as "+N".
 */
export function summarizeStepKinds(steps: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const kind = getStepKind(step);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const parts = ranked
    .slice(0, SUMMARY_KIND_LIMIT)
    .map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind));
  if (ranked.length > SUMMARY_KIND_LIMIT) {
    parts.push(`+${ranked.length - SUMMARY_KIND_LIMIT}`);
  }
  return parts.join(' · ');
}

/**
 * Time from a run's first call to its last one, or null when the timestamps
 * cannot say.
 *
 * Measured between calls only: history ships tool results without a timestamp,
 * so including the last result's time would make a finished run's duration
 * shrink the moment the live rows are replaced by the persisted ones.
 */
export function getStepsDurationMs(steps: ChatMessage[]): number | null {
  if (steps.length < 2) {
    return null;
  }

  const start = new Date(steps[0].timestamp).getTime();
  const end = new Date(steps[steps.length - 1].timestamp).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

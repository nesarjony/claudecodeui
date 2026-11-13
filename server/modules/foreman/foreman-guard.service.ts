import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * The risky-action guard for sessions Foreman starts (Milestone 5).
 *
 * `classifyToolUse` is a port of Foreman's own rules (`src/tasks/risk.ts`): cloudcli judges every tool call of a
 * guarded session with the patterns Foreman handed over, allows the safe ones without asking anybody, and only
 * routes the risky ones to a prompt. Foreman then runs the same rules again on the request it receives.
 */

export type ForemanGuardCategory = 'command' | 'secret' | 'outside_repo';

export type ForemanGuardVerdict =
  | { risky: false }
  | { risky: true; category: ForemanGuardCategory; matched: string };

/** The `guard` object of `POST /api/foreman/sessions`. Patterns are regex sources, matched case-insensitively. */
export type ForemanGuardConfig = {
  enabled: boolean;
  riskyPatterns: string[];
  secretPatterns: string[];
  writeOutsideRepo: boolean;
  /** Writes outside this directory are risky; defaults to the session's project path. */
  repoRoot?: string;
  /**
   * How long a risky call waits for an answer before it is denied as timed out (milliseconds, 1000 to 86400000).
   * A guarded session defaults to 30 minutes, long enough for a person; other sessions keep the runtime's own window.
   */
  approvalTimeoutMs?: number;
};

/** A guard whose patterns are compiled; what the classifier runs on. */
export type CompiledForemanGuard = {
  riskyPatterns: RegExp[];
  secretPatterns: RegExp[];
  writeOutsideRepo: boolean;
  repoRoot: string | null;
  approvalTimeoutMs: number;
  /** Patterns that were not valid regular expressions and are therefore not enforced. */
  skippedPatterns: number;
};

/**
 * What a runtime asks of a per-session tool policy for one tool call (see `options.toolPolicy` in the Claude
 * runtime). `allow` means no prompt at all; `ask` sends the call through the permission prompt.
 */
export type ForemanToolPolicyDecision =
  | { decision: 'allow' }
  | {
      decision: 'ask';
      category: ForemanGuardCategory;
      matched: string;
      /** How long the prompt waits for an answer before the call is denied. */
      timeoutMs: number;
      /** What the worker is told when that happens: it timed out waiting for a person, nobody refused. */
      timeoutMessage: string;
    };

export type ForemanToolPolicy = (toolName: string, input: unknown) => ForemanToolPolicyDecision;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/** Permission modes in which the CLI settles tool calls itself, so cloudcli's permission callback is never asked. */
export const GUARD_INCOMPATIBLE_PERMISSION_MODES: readonly string[] = ['acceptEdits', 'auto', 'bypassPermissions'];

/** A guarded session's prompt waits this long for a person unless the guard says otherwise. */
export const DEFAULT_GUARD_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_APPROVAL_TIMEOUT_MS = 1000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 1000;
const MAX_REPO_ROOT_LENGTH = 4096;

function compile(patterns: readonly string[]): { compiled: RegExp[]; skipped: number } {
  const compiled: RegExp[] = [];
  let skipped = 0;
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      // A broken pattern must not take the guard down: it is skipped and counted, the rest still apply.
      skipped += 1;
    }
  }
  return { compiled, skipped };
}

/** Compiles a guard's patterns once; `fallbackRepoRoot` (the session's project path) is used when it names no `repoRoot`. */
// Consumed by the sessions service, which compiles a guard per started or resumed session, and by the tests.
export function compileGuard(config: ForemanGuardConfig, fallbackRepoRoot: string | null): CompiledForemanGuard {
  const risky = compile(config.riskyPatterns);
  const secret = compile(config.secretPatterns);
  return {
    riskyPatterns: risky.compiled,
    secretPatterns: secret.compiled,
    writeOutsideRepo: config.writeOutsideRepo,
    repoRoot: config.repoRoot ?? fallbackRepoRoot,
    approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
    skippedPatterns: risky.skipped + secret.skipped,
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Plain text rather than JSON.
    }
  }
  return {};
}

function textOf(input: unknown, record: Record<string, unknown>): string {
  if (typeof record.command === 'string') {
    return record.command;
  }
  return typeof input === 'string' ? input : JSON.stringify(input ?? '');
}

/** `{a,b}` alternatives written out (one level, bounded), so `*.{pem,key}` is seen as `*.pem` and `*.key`. */
function expandBraces(glob: string, budget = { left: 64 }): string[] {
  const open = glob.indexOf('{');
  const close = open === -1 ? -1 : glob.indexOf('}', open);
  if (open === -1 || close === -1 || budget.left <= 0) {
    return [glob];
  }
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return glob.slice(open + 1, close).split(',').flatMap((option) => {
    budget.left -= 1;
    return expandBraces(head + option + tail, budget);
  });
}

/**
 * The forms a file glob can take once its wildcards are filled in. The secret patterns end in a lookahead for the end of
 * a name, so `**\/.env*` or `.env.*` would never match as written; with braces written out and each wildcard run
 * dropped or replaced by a letter, the names such a glob can match are seen too. Character classes (`[v]`) are not
 * expanded.
 */
function globVariants(glob: string): string[] {
  return expandBraces(glob).flatMap((option) => [
    option,
    option.replace(/[*?]+/g, ''),
    option.replace(/[*?]+/g, 'x'),
  ]);
}

/** The values of a call that are file globs: `glob` (Grep's file filter) and Glob's `pattern`. Grep's `pattern` is a content regex. */
function globValuesOf(toolName: string, record: Record<string, unknown>): string[] {
  const values = [record.glob, toolName === 'Glob' ? record.pattern : undefined];
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * Is this tool call one a person must approve? Pure and deterministic; Foreman's `classifyToolUse` rules, plus the file
 * globs of Glob and Grep (below).
 *
 * - Bash: the command matches a risky pattern, or mentions a secret path.
 * - Any tool: a path argument (`file_path`, `path`, `notebook_path`) matches a secret pattern.
 * - Glob (`pattern`) and any tool's `glob`: the glob can match a secret file name, wildcards included. Foreman's own
 *   classifier does not look at these; a person decides on those calls either way.
 * - Write, Edit, MultiEdit, NotebookEdit: the target is outside the repo root (when `writeOutsideRepo`).
 */
// Consumed by createToolPolicy below and by the guard tests.
export function classifyToolUse(call: { toolName: string; input: unknown }, guard: CompiledForemanGuard): ForemanGuardVerdict {
  const record = asRecord(call.input);
  const text = textOf(call.input, record);

  if (call.toolName === 'Bash') {
    for (const pattern of guard.riskyPatterns) {
      if (pattern.test(text)) {
        return { risky: true, category: 'command', matched: pattern.source };
      }
    }
    for (const pattern of guard.secretPatterns) {
      if (pattern.test(text)) {
        return { risky: true, category: 'secret', matched: pattern.source };
      }
    }
  }

  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    for (const pattern of guard.secretPatterns) {
      if (pattern.test(value)) {
        return { risky: true, category: 'secret', matched: pattern.source };
      }
    }
    if (guard.writeOutsideRepo && WRITE_TOOLS.has(call.toolName) && guard.repoRoot) {
      const root = path.resolve(guard.repoRoot);
      const target = path.resolve(root, value);
      if (target !== root && !target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
        return { risky: true, category: 'outside_repo', matched: target };
      }
    }
  }

  for (const glob of globValuesOf(call.toolName, record)) {
    for (const variant of globVariants(glob)) {
      for (const pattern of guard.secretPatterns) {
        if (pattern.test(variant)) {
          return { risky: true, category: 'secret', matched: pattern.source };
        }
      }
    }
  }
  return { risky: false };
}

function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/** The denial the worker gets when nobody answered in time: plainly a timeout, not a person's refusal. */
function timeoutMessageFor(toolName: string, approvalTimeoutMs: number): string {
  return `Timed out waiting for a person to approve this ${toolName} call: no one answered within ${describeDuration(approvalTimeoutMs)}. `
    + "This is a timeout, not a decision: no person said no. The call was not run. Do not retry it; say in your reply that it still needs a person's approval.";
}

/**
 * The per-session policy a guarded run hands to the Claude runtime. It never throws: a call the classifier could not
 * judge counts as risky, so a fault routes the call to a prompt instead of waving it through.
 */
// Consumed by the sessions service when it starts or resumes a guarded run.
export function createToolPolicy(guard: CompiledForemanGuard): ForemanToolPolicy {
  const waiting = (toolName: string) => ({
    timeoutMs: guard.approvalTimeoutMs,
    timeoutMessage: timeoutMessageFor(toolName, guard.approvalTimeoutMs),
  });
  return (toolName, input) => {
    try {
      const verdict = classifyToolUse({ toolName, input }, guard);
      return verdict.risky
        ? { decision: 'ask', category: verdict.category, matched: verdict.matched, ...waiting(toolName) }
        : { decision: 'allow' };
    } catch {
      return { decision: 'ask', category: 'command', matched: 'classifier-error', ...waiting(toolName) };
    }
  };
}

/** The SDK hooks a guarded run adds to its own (`options.toolHooks`): `{ PreToolUse: [{ matcher, hooks }] }`. */
export type ForemanGuardHooks = {
  PreToolUse: Array<{ matcher: string; hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>;
};

const CATEGORY_DESCRIPTIONS: Record<ForemanGuardCategory, string> = {
  command: 'a risky command',
  secret: 'a secret or credential path',
  outside_repo: 'a write outside the repository root',
};

/**
 * The PreToolUse hook of a guarded run. The CLI settles some calls by itself (reads inside the project, read-only shell
 * commands) and never asks `canUseTool` about them, so the guard would not see a `Read` of `.env`. This hook runs before
 * that decision and classifies every call with the same policy `canUseTool` uses. A risky call answers
 * `permissionDecision: 'ask'`, which sends it down the CLI's prompt path, that is to `canUseTool`, where the guard holds
 * it for a person. A safe call answers nothing: the hook never allows anything by itself. Never throws; an input it cannot
 * read is asked about.
 */
// Consumed by guardRunOptions below and by the guard tests.
export function guardHooks(guard: CompiledForemanGuard): ForemanGuardHooks {
  const policy = createToolPolicy(guard);
  const ask = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  });
  return {
    PreToolUse: [{
      matcher: '',
      hooks: [async (input) => {
        const record = asRecord(input);
        if (typeof record.tool_name !== 'string' || !record.tool_name) {
          return ask('Foreman guard: the tool call could not be read, so a person must approve it.');
        }
        const verdict = policy(record.tool_name, record.tool_input);
        if (verdict.decision !== 'ask') {
          return {};
        }
        return ask(`Foreman guard: ${CATEGORY_DESCRIPTIONS[verdict.category]} (${verdict.matched}); a person must approve this call.`);
      }],
    }],
  };
}

/** What a guarded run hands to the Claude runtime: the policy for `canUseTool` and the hook that feeds it. */
// Consumed by the sessions service when it starts or resumes a guarded run.
export function guardRunOptions(guard: CompiledForemanGuard): { toolPolicy: ForemanToolPolicy; toolHooks: ForemanGuardHooks } {
  return { toolPolicy: createToolPolicy(guard), toolHooks: guardHooks(guard) };
}

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

function readPatternList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw invalid(`guard.${field} must be an array of regular expression sources.`);
  }
  if (value.length > MAX_PATTERNS) {
    throw invalid(`guard.${field} may hold at most ${MAX_PATTERNS} patterns.`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_PATTERN_LENGTH) {
      throw invalid(`guard.${field} entries must be non-empty strings of at most ${MAX_PATTERN_LENGTH} characters.`);
    }
    return entry;
  });
}

/**
 * Validates the `guard` of a start-session body. Absent or `null` means no guard (`undefined`); a present guard must be
 * an object with a boolean `enabled`. A disabled guard is accepted as-is and enforces nothing; an enabled one needs
 * both pattern lists (they may be empty), because a guard that silently has no rules would look protective and not be.
 * `approvalTimeoutMs` is optional (an integer, 1000 to 86400000) and defaults to 30 minutes; the result always carries
 * it, so what is stored with the guard is the window actually in force. Invalid regular expressions are not an error
 * here: they are skipped when the guard is compiled.
 */
// Consumed by foreman.routes.ts for `POST /sessions`.
export function parseGuardConfig(raw: unknown): ForemanGuardConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('guard must be an object.');
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') {
    throw invalid('guard.enabled is required and must be a boolean.');
  }
  if (!body.enabled) {
    return { enabled: false, riskyPatterns: [], secretPatterns: [], writeOutsideRepo: false };
  }

  if (body.writeOutsideRepo !== undefined && typeof body.writeOutsideRepo !== 'boolean') {
    throw invalid('guard.writeOutsideRepo must be a boolean.');
  }
  let repoRoot: string | undefined;
  if (body.repoRoot !== undefined && body.repoRoot !== null) {
    if (typeof body.repoRoot !== 'string' || !body.repoRoot.trim().startsWith('/') || body.repoRoot.length > MAX_REPO_ROOT_LENGTH) {
      throw invalid('guard.repoRoot must be an absolute path.');
    }
    repoRoot = body.repoRoot.trim();
  }
  const approvalTimeoutMs = body.approvalTimeoutMs ?? DEFAULT_GUARD_APPROVAL_TIMEOUT_MS;
  if (
    typeof approvalTimeoutMs !== 'number'
    || !Number.isInteger(approvalTimeoutMs)
    || approvalTimeoutMs < MIN_APPROVAL_TIMEOUT_MS
    || approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS
  ) {
    throw invalid(`guard.approvalTimeoutMs must be an integer between ${MIN_APPROVAL_TIMEOUT_MS} and ${MAX_APPROVAL_TIMEOUT_MS} (milliseconds).`);
  }
  return {
    enabled: true,
    riskyPatterns: readPatternList(body.riskyPatterns, 'riskyPatterns'),
    secretPatterns: readPatternList(body.secretPatterns, 'secretPatterns'),
    // Unspecified means the stricter choice.
    writeOutsideRepo: body.writeOutsideRepo !== false,
    ...(repoRoot ? { repoRoot } : {}),
    approvalTimeoutMs,
  };
}

/** Refuses a permission mode the guard cannot work under (see `GUARD_INCOMPATIBLE_PERMISSION_MODES`). */
// Consumed by the sessions service when a guarded session starts or is sent a message with an explicit mode.
export function assertGuardCompatiblePermissionMode(permissionMode: string | undefined): void {
  if (permissionMode && GUARD_INCOMPATIBLE_PERMISSION_MODES.includes(permissionMode)) {
    throw new AppError(
      `A guarded session cannot run in permission mode "${permissionMode}": the CLI would settle tool calls itself and the guard would never be asked. Use "default" (or "plan").`,
      { code: 'GUARD_INCOMPATIBLE_PERMISSION_MODE', statusCode: 400 },
    );
  }
}

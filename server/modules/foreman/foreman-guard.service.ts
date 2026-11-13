import path from 'node:path';

import {
  bashSecretLabel,
  coversSecretDirectories,
  expandHome,
  globVariants,
  resolveHome,
  searchTargetLabel,
  secretPathLabel,
  type SecretScope,
} from '@/modules/foreman/foreman-guard-secrets.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * The risky-action guard for sessions Foreman starts (Milestone 5).
 *
 * `classifyToolUse` is a port of Foreman's own rules (`src/tasks/risk.ts`): cloudcli judges every tool call of a
 * guarded session with the patterns Foreman handed over, allows the safe ones without asking anybody, and only
 * routes the risky ones to a prompt. Foreman then runs the same rules again on the request it receives.
 *
 * On top of the patterns Foreman hands over, the built-in secret classes of `foreman-guard-secrets.service.ts` always
 * apply to a guarded session: `.env*`, `*.pem`, SSH keys, `credentials*`, token/key/secret files under `~/.config`, and
 * the secret directories. They are checked for every path argument, for the file globs and search roots of Grep and
 * Glob, and for every word of a Bash command.
 *
 * Foreman runs these sessions unattended, so the two tools only a person can answer, AskUserQuestion and ExitPlanMode,
 * are refused outright (see `unattendedToolDenial`) instead of being asked about: a prompt for them would wait for a
 * person who is not there, and the worker would hang.
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
  /** The home directory the built-in secret classes protect (`~/.ssh`, `~/.config/**`); captured when the guard is compiled. */
  home: string;
};

/**
 * What a runtime asks of a per-session tool policy for one tool call (see `options.toolPolicy` in the Claude
 * runtime). `allow` means no prompt at all; `deny` refuses the call at once, with no prompt, and `message` is the
 * reason the worker is told; `ask` sends the call through the permission prompt.
 */
export type ForemanToolPolicyDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; message: string }
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

/** What a guarded worker is told when it calls AskUserQuestion: Foreman runs the session, so nobody is there to answer. */
export const ASK_USER_QUESTION_DENIAL = 'Foreman guard: no person is available to answer AskUserQuestion in this session, because Foreman runs it. Decide per the repo docs, or list the question in your final report under OPEN QUESTIONS and carry on with the parts that do not depend on it. Never guess an answer to a question the repo documents as open for a person (for example EVIDENCE §7).';

/** What a guarded worker is told when it calls ExitPlanMode: nobody can approve a plan. */
export const EXIT_PLAN_MODE_DENIAL = 'Foreman guard: no person is available to approve a plan in this session, because Foreman runs it. Do not use plan mode: carry out the work directly.';

/**
 * The refusal for a tool that only a person can answer, or null for every other tool. A guarded session has no person
 * watching it, and the prompt for these two tools waits without any timeout, so without this the worker would hang
 * forever. Pure; the tool name is matched exactly, and anything that is not a string is no such tool.
 */
// Consumed by createToolPolicy below, which both the PreToolUse hook and the Claude runtime's canUseTool ask.
export function unattendedToolDenial(toolName: unknown): string | null {
  switch (toolName) {
    case 'AskUserQuestion':
      return ASK_USER_QUESTION_DENIAL;
    case 'ExitPlanMode':
      return EXIT_PLAN_MODE_DENIAL;
    default:
      return null;
  }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The arguments that name a file or directory a tool reads or writes (Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, LS, ...).
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'notebookPath', 'directory', 'dir', 'cwd'];
// Arguments that hold several of them.
const PATH_LIST_KEYS = ['paths', 'file_paths', 'filePaths'];
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

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
// `options.home` replaces the process's home directory (tests).
export function compileGuard(config: ForemanGuardConfig, fallbackRepoRoot: string | null, options: { home?: string } = {}): CompiledForemanGuard {
  const risky = compile(config.riskyPatterns);
  const secret = compile(config.secretPatterns);
  return {
    riskyPatterns: risky.compiled,
    secretPatterns: secret.compiled,
    writeOutsideRepo: config.writeOutsideRepo,
    repoRoot: config.repoRoot ?? fallbackRepoRoot,
    approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
    skippedPatterns: risky.skipped + secret.skipped,
    home: path.resolve(options.home ?? resolveHome()),
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

/**
 * The values of a call that are file globs: `glob` and `include` (Grep's file filters) and Glob's `pattern`. Grep's
 * `pattern` is a content regex, not a file name, and is not one of them.
 */
function globValuesOf(toolName: string, record: Record<string, unknown>): string[] {
  const values = [record.glob, record.include, toolName === 'Glob' ? record.pattern : undefined];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** The string values of the arguments that name a path (a list argument contributes each of its strings). */
function pathValuesOf(record: Record<string, unknown>): string[] {
  const values: unknown[] = PATH_KEYS.map((key) => record[key]);
  for (const key of PATH_LIST_KEYS) {
    const list = record[key];
    if (Array.isArray(list)) {
      values.push(...list);
    }
  }
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * Is this tool call one a person must approve? Pure and deterministic; Foreman's `classifyToolUse` rules, plus the
 * built-in secret classes and the file globs of Glob and Grep (see `foreman-guard-secrets.service.ts`).
 *
 * - Bash: the command matches a risky pattern, or mentions a secret: the session's secret patterns match its text, or
 *   a word of it is a built-in secret path (`cat`, `grep`, `cp`, `source`, `< file`, `$(cat file)`, `curl -d @file`, a pipe
 *   out of any of those, ...), or a directory walker is pointed at `~` or `~/.config`.
 * - Any tool: a path argument (`file_path`, `path`, `notebook_path`, ...) matches a secret pattern or is a built-in
 *   secret path (Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, LS, ...); `~` and `$HOME` are expanded.
 * - Grep and Glob: the `path` they search from is a secrets directory or holds one (`~`, `~/.config`, `/`), or the
 *   file glob they carry (`glob`, `include`, Glob's `pattern`) can match a secret file name, wildcards included, with
 *   `path` read as the glob's base. Grep's own `pattern` is a content regex and is not judged.
 * - Write, Edit, MultiEdit, NotebookEdit: the target is outside the repo root (when `writeOutsideRepo`).
 *
 * Foreman's own classifier knows only the first two points (patterns over paths and commands), so it can judge a call
 * safe that this one holds; the call is held here either way.
 */
// Consumed by createToolPolicy below and by the guard tests.
export function classifyToolUse(call: { toolName: string; input: unknown }, guard: CompiledForemanGuard): ForemanGuardVerdict {
  const record = asRecord(call.input);
  const text = textOf(call.input, record);
  const scope: SecretScope = { home: guard.home, cwd: path.resolve(guard.repoRoot ?? '/') };
  const secret = (matched: string): ForemanGuardVerdict => ({ risky: true, category: 'secret', matched });

  if (call.toolName === 'Bash') {
    for (const pattern of guard.riskyPatterns) {
      if (pattern.test(text)) {
        return { risky: true, category: 'command', matched: pattern.source };
      }
    }
    for (const pattern of guard.secretPatterns) {
      if (pattern.test(text)) {
        return secret(pattern.source);
      }
    }
    const reads = bashSecretLabel(text, scope);
    if (reads) {
      return secret(reads);
    }
  }

  for (const value of pathValuesOf(record)) {
    for (const pattern of guard.secretPatterns) {
      if (pattern.test(value)) {
        return secret(pattern.source);
      }
    }
    const label = secretPathLabel(value, scope);
    if (label) {
      return secret(label);
    }
    if (guard.writeOutsideRepo && WRITE_TOOLS.has(call.toolName) && guard.repoRoot) {
      const root = path.resolve(guard.repoRoot);
      // The CLI expands `~` and `$HOME` in a path argument, so a write to `~/.bashrc` is not inside the repo.
      const target = path.resolve(root, expandHome(value, guard.home));
      if (target !== root && !target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
        return { risky: true, category: 'outside_repo', matched: target };
      }
    }
  }

  const globs = globValuesOf(call.toolName, record);
  for (const glob of globs) {
    for (const variant of globVariants(glob)) {
      for (const pattern of guard.secretPatterns) {
        if (pattern.test(variant)) {
          return secret(pattern.source);
        }
      }
    }
  }
  const searchRoot = typeof record.path === 'string' && record.path ? record.path : undefined;
  const searched = searchTargetLabel(searchRoot, globs, scope);
  if (searched) {
    return secret(searched);
  }
  if (SEARCH_TOOLS.has(call.toolName) && searchRoot && coversSecretDirectories(searchRoot, scope, true)) {
    return secret('a search from a directory that holds secrets (~, ~/.config, /)');
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
 * judge counts as risky, so a fault routes the call to a prompt instead of waving it through. AskUserQuestion and
 * ExitPlanMode are denied outright (`unattendedToolDenial`), before any classification, whatever their input.
 */
// Consumed by the sessions service when it starts or resumes a guarded run.
export function createToolPolicy(guard: CompiledForemanGuard): ForemanToolPolicy {
  const waiting = (toolName: string) => ({
    timeoutMs: guard.approvalTimeoutMs,
    timeoutMessage: timeoutMessageFor(toolName, guard.approvalTimeoutMs),
  });
  return (toolName, input) => {
    const denial = unattendedToolDenial(toolName);
    if (denial) {
      return { decision: 'deny', message: denial };
    }
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
 * that decision, for every tool call whatever the permission rules say, and classifies the call with the same policy
 * `canUseTool` uses. A risky call answers `permissionDecision: 'ask'`, which sends it down the CLI's prompt path, that is
 * to `canUseTool`, where the guard holds it for a person. A safe call answers nothing: the hook never allows anything by
 * itself. Never throws; an input it cannot read is asked about.
 *
 * AskUserQuestion and ExitPlanMode are the exception to "safe answers nothing": no person is there to answer a question
 * or approve a plan, so the hook denies them (`permissionDecision: 'deny'`, with the reason in `unattendedToolDenial`)
 * in every permission mode, including the ones that settle calls without asking. Asking would hang the worker.
 *
 * `ask` only works when the CLI really prompts. In a permission mode that settles calls without asking
 * (`GUARD_INCOMPATIBLE_PERMISSION_MODES`, which the hook input reports as `permission_mode`, for example after a person
 * switched the session's mode in the chat), nobody could hold the call, so a risky call is denied outright with a reason
 * that says why: failing closed rather than letting it through.
 */
// Consumed by guardRunOptions below and by the guard tests.
export function guardHooks(guard: CompiledForemanGuard): ForemanGuardHooks {
  const policy = createToolPolicy(guard);
  const answer = (decision: 'ask' | 'deny', reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  });
  return {
    PreToolUse: [{
      matcher: '',
      hooks: [async (input) => {
        const record = asRecord(input);
        const mode = typeof record.permission_mode === 'string' ? record.permission_mode : '';
        const cannotHold = GUARD_INCOMPATIBLE_PERMISSION_MODES.includes(mode);
        const hold = (subject: string) => cannotHold
          ? answer('deny', `Foreman guard: ${subject}. The session is in permission mode "${mode}", which settles calls without asking a person, so the guard cannot hold this call: it was denied. A person can switch the session to "default" and ask again.`)
          : answer('ask', `Foreman guard: ${subject}; a person must approve this call.`);
        if (typeof record.tool_name !== 'string' || !record.tool_name) {
          return hold('the tool call could not be read');
        }
        const verdict = policy(record.tool_name, record.tool_input);
        if (verdict.decision === 'deny') {
          return answer('deny', verdict.message);
        }
        if (verdict.decision !== 'ask') {
          return {};
        }
        return hold(`${CATEGORY_DESCRIPTIONS[verdict.category]} (${verdict.matched})`);
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

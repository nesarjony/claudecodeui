import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { classifyCore } from '@/modules/foreman/foreman-guard-classify.service.js';
import { resolveHome } from '@/modules/foreman/foreman-guard-secrets.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * The risky-action guard for sessions Foreman starts (Milestone 5, hardened by the red-team pass).
 *
 * `classifyToolUse` judges every tool call of a guarded session with the patterns Foreman handed over, allows the safe
 * ones without asking anybody, and only routes the risky ones to a prompt. Foreman then runs the same rules again on the
 * request it receives. The rules themselves live in three files that are copies of Foreman's own `src/guard/` (`secrets.ts`,
 * `shell.ts`, `classify.ts`), overwritten by Foreman's sync script and never edited here: `foreman-guard-secrets.service.ts`
 * (the secret classes), `foreman-guard-shell.service.ts` (the structural shell reader) and
 * `foreman-guard-classify.service.ts` (the shared classifier this file delegates to).
 *
 * A Bash command is read structurally, not matched as text, so it is held when it does any of these however it is spelled:
 * `git push`/`reset --hard`/`clean`/... behind global options (`-C`, `-c`, `--git-dir`), `rm -r`/`-f`, `find -delete`/`-exec rm`,
 * `sudo`/`su`/`doas`, `env`/`printenv` dumps and secret-named variables, uploads (`curl -T`/`-d @file`/`--data-binary`, `scp`, `rsync`, `nc`), a
 * script, package script (`npm run`, `make` target, ...) or file it is about to run and whose text is risky, a write
 * outside the repo (redirects, `tee`, `cp`/`mv`/`ln` targets, `sed -i`, ...) or into `.git/hooks`, `.git/config`, `.claude/`,
 * `.mcp.json`, and anything that reads a secret (the built-in classes of `foreman-guard-secrets.service.ts`: `.env*`,
 * `*.pem`, SSH keys, `credentials*`, token/key/secret files under `~/.config`, the secret directories).
 *
 * The same secret classes apply to every path argument of any tool and to the file globs and search roots of Grep and
 * Glob; links are followed, so a link in the repo that points at a secret is that secret. Write, Edit, MultiEdit and
 * NotebookEdit are held when the target (links resolved) is outside the repo root or is one of the repository's protected
 * files (`.git/hooks`, `.git/config`, `.claude/`, `.mcp.json`).
 *
 * What is not a path is not matched as one: the text of an `awk` or `sed` program, a `grep` pattern, a `jq` filter and the code of `node -e` or
 * `python -c` are not judged as paths (a `.key` property in a script is not a key file), the files they read are. A wildcard that a read-only
 * command expands is resolved against the file system and held only when a file it matches is a secret; a `find`, `ls` or `git ls-files` in a command
 * substitution is run (without a shell, for a few seconds) and the paths it prints are judged. `referenceDirs` are read-only repositories: every write into
 * one is held.
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
  /**
   * Absolute directories where a Write, Edit, MultiEdit or NotebookEdit of a plain file is NOT an `outside_repo` hold: Foreman's
   * per-task scratch directory and `/tmp`. Secrets still hold (the secret classes run first), and so does a dotfile or a file in a
   * dot-directory below the allowed directory. Symlinks are resolved first. Absent: every write outside `repoRoot` is held.
   */
  allowWriteDirs?: string[];
  /**
   * Absolute directories of other repositories the session may read and never write (Foreman's `guard.referenceDirs`: the donor repos a
   * parity task studies). Reading them follows the ordinary secret rules; every write into one is held, whatever else would allow it, and so is a
   * git command that changes one. Absent: none.
   */
  referenceDirs?: string[];
};

/** A guard whose patterns are compiled; what the classifier runs on. */
export type CompiledForemanGuard = {
  riskyPatterns: RegExp[];
  secretPatterns: RegExp[];
  writeOutsideRepo: boolean;
  repoRoot: string | null;
  approvalTimeoutMs: number;
  /** Directories where a plain, non-secret, non-dotfile write outside the repo root is allowed (see `ForemanGuardConfig.allowWriteDirs`). */
  allowWriteDirs: string[];
  /** Read-only repositories (see `ForemanGuardConfig.referenceDirs`). */
  referenceDirs: string[];
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
      /**
       * True when this guard has `allowWriteDirs`: the hold was made by a guard that already lets plain scratch and /tmp files through
       * (judging them on the real file system, symlinks resolved), so a write that LOOKS like one of them and is held anyway was held for
       * a reason. Foreman reads it from the permission event and does not allow such a hold by itself.
       */
      allowlist: boolean;
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

/** Permission modes in which the CLI settles tool calls itself, so cloudcli's permission callback is never asked. */
export const GUARD_INCOMPATIBLE_PERMISSION_MODES: readonly string[] = ['acceptEdits', 'auto', 'bypassPermissions'];

/** A guarded session's prompt waits this long for a person unless the guard says otherwise. */
export const DEFAULT_GUARD_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_APPROVAL_TIMEOUT_MS = 1000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 1000;
const MAX_REPO_ROOT_LENGTH = 4096;
const MAX_ALLOW_WRITE_DIRS = 20;
const MAX_REFERENCE_DIRS = 20;

/** A symlink chain longer than this is a loop, or as good as one: it resolves to the root, which is outside every allowed directory. */
const MAX_LINKS = 40;

/**
 * `target` with symlinks resolved. A path that does not exist yet resolves through its nearest existing directory. A DANGLING symlink (one
 * whose target does not exist yet) is followed too: a write through it creates its target, so that is where the write goes.
 */
function realish(target: string, links = 0): string {
  let head = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? path.resolve(real, ...tail.reverse()) : real;
    } catch {
      try {
        if (lstatSync(head).isSymbolicLink()) {
          if (links >= MAX_LINKS) {
            return path.sep;
          }
          const linked = path.resolve(path.dirname(head), readlinkSync(head));
          return realish(tail.length ? path.resolve(linked, ...tail.reverse()) : linked, links + 1);
        }
      } catch {
        // Not a link either: it does not exist.
      }
      const parent = path.dirname(head);
      if (parent === head) {
        return path.resolve(target);
      }
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function isPlainFileOrMissing(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return true;
  }
}

/**
 * Is writing `target` allowed by one of the guard's `allowWriteDirs`? The file is strictly inside one of them (symlinks resolved),
 * plain, and no part of its path below that directory is a dot-name. Secrets are judged before this is asked.
 */
function writeAllowedByDirs(target: string, dirs: readonly string[]): boolean {
  const real = realish(target);
  for (const dir of dirs) {
    const root = realish(dir);
    if (root === path.sep) {
      continue;
    }
    const rel = path.relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      continue;
    }
    if (rel.split(path.sep).some((part) => part.startsWith('.'))) {
      continue;
    }
    if (isPlainFileOrMissing(real)) {
      return true;
    }
  }
  return false;
}

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
  const home = path.resolve(options.home ?? resolveHome());
  // A directory that holds the home directory would allow `~/.bashrc`: never honoured, whatever the caller sent.
  const holdsHome = (dir: string) => {
    const rel = path.relative(realish(dir), realish(home));
    return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  };
  const allowWriteDirs = (config.allowWriteDirs ?? []).filter((dir) => path.isAbsolute(dir) && path.resolve(dir) !== path.sep && !holdsHome(dir));
  return {
    riskyPatterns: risky.compiled,
    secretPatterns: secret.compiled,
    writeOutsideRepo: config.writeOutsideRepo,
    repoRoot: config.repoRoot ?? fallbackRepoRoot,
    approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
    allowWriteDirs,
    referenceDirs: (config.referenceDirs ?? []).filter((dir) => path.isAbsolute(dir) && path.resolve(dir) !== path.sep),
    skippedPatterns: risky.skipped + secret.skipped,
    home,
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

/**
 * Is this tool call one a person must approve? Pure and deterministic apart from reading the files a command is about to
 * run and resolving links (the shared classifier's `ShellFs`). Delegates to `classifyCore`, the same classifier Foreman runs
 * (see the header of this file for what it covers); the guard is already compiled, so its patterns, repo root and home
 * are handed over as they are.
 *
 * A plain, non-secret, non-dotfile write inside one of the guard's `allowWriteDirs` (Foreman's per-task scratch directory, `/tmp`)
 * is not a write that leaves the repo's rules. Only that one verdict is waived: the shared classifier is asked again with writes
 * outside the repo switched off, so a secret, a protected repo file or a risky command in the same call still holds it.
 */
// Consumed by createToolPolicy below and by the guard tests.
export function classifyToolUse(call: { toolName: string; input: unknown }, guard: CompiledForemanGuard): ForemanGuardVerdict {
  const rules = {
    riskyPatterns: guard.riskyPatterns,
    secretPatterns: guard.secretPatterns,
    writeOutsideRepo: guard.writeOutsideRepo,
    repoRoot: guard.repoRoot,
    home: guard.home,
    referenceDirs: guard.referenceDirs,
    scratchDirs: guard.allowWriteDirs,
  };
  const verdict = classifyCore(call, rules);
  if (verdict.risky && verdict.category === 'outside_repo' && guard.allowWriteDirs.length > 0 && WRITE_TOOLS.has(call.toolName) && writeAllowedByDirs(verdict.matched, guard.allowWriteDirs)) {
    return classifyCore(call, { ...rules, writeOutsideRepo: false });
  }
  return verdict;
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
    allowlist: guard.allowWriteDirs.length > 0,
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
  let allowWriteDirs: string[] | undefined;
  if (body.allowWriteDirs !== undefined && body.allowWriteDirs !== null) {
    if (
      !Array.isArray(body.allowWriteDirs)
      || body.allowWriteDirs.length > MAX_ALLOW_WRITE_DIRS
      || body.allowWriteDirs.some((dir) => typeof dir !== 'string' || !dir.trim().startsWith('/') || dir.length > MAX_REPO_ROOT_LENGTH)
    ) {
      throw invalid(`guard.allowWriteDirs must be an array of at most ${MAX_ALLOW_WRITE_DIRS} absolute paths.`);
    }
    allowWriteDirs = (body.allowWriteDirs as string[]).map((dir) => dir.trim());
  }
  let referenceDirs: string[] | undefined;
  if (body.referenceDirs !== undefined && body.referenceDirs !== null) {
    if (
      !Array.isArray(body.referenceDirs)
      || body.referenceDirs.length > MAX_REFERENCE_DIRS
      || body.referenceDirs.some((dir) => typeof dir !== 'string' || !dir.trim().startsWith('/') || dir.trim() === '/' || dir.length > MAX_REPO_ROOT_LENGTH)
    ) {
      throw invalid(`guard.referenceDirs must be an array of at most ${MAX_REFERENCE_DIRS} absolute paths other than /.`);
    }
    referenceDirs = (body.referenceDirs as string[]).map((dir) => dir.trim());
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
    ...(allowWriteDirs ? { allowWriteDirs } : {}),
    ...(referenceDirs ? { referenceDirs } : {}),
    approvalTimeoutMs,
  };
}

/**
 * Creates the guard's `allowWriteDirs` that do not exist yet (mode 0700), so the scratch directory Foreman names in a worker's prompt is
 * really there: Foreman itself may run with a private /tmp and cannot make it where the worker looks. Never throws; a directory that
 * cannot be made is left to the worker's own `mkdir -p` (a Write creates its parent directories anyway).
 */
// Consumed by the sessions service when a guarded session starts.
export function ensureAllowWriteDirs(guard: CompiledForemanGuard): string[] {
  const made: string[] = [];
  for (const dir of guard.allowWriteDirs) {
    try {
      statSync(dir);
    } catch {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        made.push(dir);
      } catch {
        // Left to the worker.
      }
    }
  }
  return made;
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

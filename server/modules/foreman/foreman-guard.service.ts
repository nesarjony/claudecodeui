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
};

/** A guard whose patterns are compiled; what the classifier runs on. */
export type CompiledForemanGuard = {
  riskyPatterns: RegExp[];
  secretPatterns: RegExp[];
  writeOutsideRepo: boolean;
  repoRoot: string | null;
  /** Patterns that were not valid regular expressions and are therefore not enforced. */
  skippedPatterns: number;
};

/**
 * What a runtime asks of a per-session tool policy for one tool call (see `options.toolPolicy` in the Claude
 * runtime). `allow` means no prompt at all; `ask` sends the call through the permission prompt.
 */
export type ForemanToolPolicyDecision =
  | { decision: 'allow' }
  | { decision: 'ask'; category: ForemanGuardCategory; matched: string };

export type ForemanToolPolicy = (toolName: string, input: unknown) => ForemanToolPolicyDecision;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/** Permission modes in which the CLI settles tool calls itself, so cloudcli's permission callback is never asked. */
export const GUARD_INCOMPATIBLE_PERMISSION_MODES: readonly string[] = ['acceptEdits', 'auto', 'bypassPermissions'];

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

/**
 * Is this tool call one a person must approve? Pure and deterministic; the same rules as Foreman's `classifyToolUse`.
 *
 * - Bash: the command matches a risky pattern, or mentions a secret path.
 * - Any tool: a path argument (`file_path`, `path`, `notebook_path`) matches a secret pattern.
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
  return { risky: false };
}

/**
 * The per-session policy a guarded run hands to the Claude runtime. It never throws: a call the classifier could not
 * judge counts as risky, so a fault routes the call to a prompt instead of waving it through.
 */
// Consumed by the sessions service when it starts or resumes a guarded run.
export function createToolPolicy(guard: CompiledForemanGuard): ForemanToolPolicy {
  return (toolName, input) => {
    try {
      const verdict = classifyToolUse({ toolName, input }, guard);
      return verdict.risky
        ? { decision: 'ask', category: verdict.category, matched: verdict.matched }
        : { decision: 'allow' };
    } catch {
      return { decision: 'ask', category: 'command', matched: 'classifier-error' };
    }
  };
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
 * an object with a boolean `enabled`. A disabled guard is accepted as-is and enforces nothing; an enabled one needs both
 * pattern lists (they may be empty), because a guard that silently has no rules would look protective and not be.
 * Invalid regular expressions are not an error here: they are skipped when the guard is compiled.
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
  return {
    enabled: true,
    riskyPatterns: readPatternList(body.riskyPatterns, 'riskyPatterns'),
    secretPatterns: readPatternList(body.secretPatterns, 'secretPatterns'),
    // Unspecified means the stricter choice.
    writeOutsideRepo: body.writeOutsideRepo !== false,
    ...(repoRoot ? { repoRoot } : {}),
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

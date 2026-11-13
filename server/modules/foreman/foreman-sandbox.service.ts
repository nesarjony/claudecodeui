import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * The sandbox of the sessions Foreman starts (Foreman core v2, step 1: isolation instead of inspection).
 *
 * Foreman owns the policy as data and delivers a TEMPLATE through `GET /foreman/runtime-config` (`workers.sandbox`); a session start names what
 * is specific to one task (its scratch directory, extra writable paths, protected paths). This file fills the template for a run and turns it
 * into the options Claude Code understands: the SDK `sandbox` option (bubblewrap around every Bash call), permission rules for the file tools,
 * denied tools and the CLI's environment. It reads no command and judges no tool call.
 *
 * `fillTemplate` and `sdkSandboxOptions` are the same functions as in Foreman's `src/sandbox/policy.ts`; `tests/fixtures/sandbox-template.golden.json`
 * (generated from that file) is what both repositories' tests compare against. The switches that make the sandbox a sandbox are forced on here
 * again, whatever the template says: a corrupt or hostile policy can narrow a session, never widen it.
 */

export type SandboxTemplate = {
  sandbox: {
    network: { allowedDomains: string[]; allowAllUnixSockets: boolean };
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
    credentials: { envVars: Array<{ name: string; mode: 'deny' }> };
  };
  permissions: { allow: string[]; deny: string[] };
  disallowedTools: string[];
  env: Record<string, string>;
};

/** What `workers.sandbox` of the runtime config says. */
export type ForemanSandboxPolicy = { enabled: boolean; template: SandboxTemplate };

/** What one session needs beyond the template; stored with the session so a resumed run (after a restart too) is sandboxed the same way. */
export type ForemanSandboxState = {
  scratchDir: string;
  /** Extra writable paths of this task (a git worktree's common git dir). */
  writeDirs: string[];
  /** Paths relative to the project path that nobody may write (somebody else's uncommitted work). */
  protectedPaths: string[];
  /** How long a prompt that still reaches a person waits before it is denied. */
  approvalTimeoutMs: number | null;
};

/** What a run is given: the pieces `claude-runtime.provider.js` merges into its SDK options. */
export type ForemanSandboxAdditions = {
  /** The SDK `sandbox` option. */
  sandbox: Record<string, unknown>;
  permissions: { allow: string[]; deny: string[] };
  disallowedTools: string[];
  env: Record<string, string>;
};

const MAX_ENTRIES = 400;
const MAX_ENTRY_LENGTH = 1000;
const MAX_PATH_LENGTH = 4096;
const MIN_APPROVAL_TIMEOUT_MS = 1000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    return null;
  }
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      return null;
    }
    list.push(entry);
  }
  return list;
}

const unique = (list: string[]): string[] => [...new Set(list)];

/** `workers.sandbox` of the runtime config, or null when it is missing or malformed (a sandboxed session then does not run: see `requireSandboxAdditions`). */
export function parseSandboxPolicy(value: unknown): ForemanSandboxPolicy | null {
  const policy = asRecord(value);
  const template = asRecord(policy?.template);
  const sandbox = asRecord(template?.sandbox);
  const network = asRecord(sandbox?.network);
  const filesystem = asRecord(sandbox?.filesystem);
  const credentials = asRecord(sandbox?.credentials);
  const permissions = asRecord(template?.permissions);
  const env = asRecord(template?.env);
  if (!policy || typeof policy.enabled !== 'boolean' || !template || !sandbox || !network || !filesystem || !credentials || !permissions || !env) {
    return null;
  }
  const allowedDomains = stringList(network.allowedDomains);
  const denyRead = stringList(filesystem.denyRead);
  const allowRead = stringList(filesystem.allowRead);
  const allowWrite = stringList(filesystem.allowWrite);
  const denyWrite = stringList(filesystem.denyWrite);
  const allow = stringList(permissions.allow);
  const deny = stringList(permissions.deny);
  const disallowedTools = stringList(template.disallowedTools);
  if (!allowedDomains || !denyRead || !allowRead || !allowWrite || !denyWrite || !allow || !deny || !disallowedTools || !Array.isArray(credentials.envVars)) {
    return null;
  }
  const envVars: Array<{ name: string; mode: 'deny' }> = [];
  for (const entry of credentials.envVars) {
    const item = asRecord(entry);
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)) {
      return null;
    }
    envVars.push({ name: item.name, mode: 'deny' });
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string') {
      return null;
    }
    environment[key] = entry;
  }
  return {
    enabled: policy.enabled,
    template: {
      sandbox: {
        network: { allowedDomains, allowAllUnixSockets: network.allowAllUnixSockets === true },
        filesystem: { denyRead, allowRead, allowWrite, denyWrite },
        credentials: { envVars },
      },
      permissions: { allow, deny },
      disallowedTools,
      env: environment,
    },
  };
}

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_PATH_LENGTH && path.isAbsolute(value) && path.resolve(value) !== path.sep && !value.includes('\0');

/**
 * Validates the `sandbox` of a start-session body. Absent or `null` means no sandbox (`undefined`); a present one must be an object with
 * `enabled: true` and an absolute `scratchDir`. Old guard-shaped bodies are refused by the caller (`guard` is not accepted any more).
 */
// Consumed by foreman.routes.ts for `POST /sessions`.
export function parseSandboxStart(raw: unknown): ForemanSandboxState | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const body = asRecord(raw);
  if (!body) {
    throw invalid('sandbox must be an object.');
  }
  if (body.enabled !== true) {
    throw invalid('sandbox.enabled must be true (omit sandbox for a session without one).');
  }
  if (!isAbsolutePath(body.scratchDir)) {
    throw invalid('sandbox.scratchDir must be an absolute path.');
  }
  const writeDirs = body.writeDirs === undefined ? [] : stringList(body.writeDirs);
  if (!writeDirs || !writeDirs.every(isAbsolutePath)) {
    throw invalid('sandbox.writeDirs must be an array of absolute paths.');
  }
  const protectedPaths = body.protectedPaths === undefined ? [] : stringList(body.protectedPaths);
  if (!protectedPaths || protectedPaths.some((entry) => path.isAbsolute(entry) || entry.split('/').includes('..'))) {
    throw invalid('sandbox.protectedPaths must be an array of paths relative to the project.');
  }
  let approvalTimeoutMs: number | null = null;
  if (body.approvalTimeoutMs !== undefined && body.approvalTimeoutMs !== null) {
    const value = body.approvalTimeoutMs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_APPROVAL_TIMEOUT_MS || value > MAX_APPROVAL_TIMEOUT_MS) {
      throw invalid(`sandbox.approvalTimeoutMs must be an integer between ${MIN_APPROVAL_TIMEOUT_MS} and ${MAX_APPROVAL_TIMEOUT_MS} (milliseconds).`);
    }
    approvalTimeoutMs = value;
  }
  return { scratchDir: body.scratchDir, writeDirs: unique(writeDirs), protectedPaths: unique(protectedPaths), approvalTimeoutMs };
}

/**
 * The sandbox a session stored before sandboxes existed, or one whose stored state cannot be read, gets: isolation is never lost silently. Its
 * scratch directory is a fixed place under the temp directory.
 */
// Consumed by the session state service when it reads a stored row.
export function fallbackSandboxState(): ForemanSandboxState {
  return { scratchDir: path.join(os.tmpdir(), 'foreman-scratch', 'legacy'), writeDirs: [], protectedPaths: [], approvalTimeoutMs: null };
}

/** A stored sandbox state, read defensively. Returns null when the JSON is not one (the caller then uses `fallbackSandboxState`). */
// Consumed by the session state service.
export function parseStoredSandboxState(raw: unknown): ForemanSandboxState | null {
  const body = asRecord(raw);
  if (!body || body.kind !== 'sandbox') {
    return null;
  }
  try {
    return parseSandboxStart({ enabled: true, scratchDir: body.scratchDir, writeDirs: body.writeDirs, protectedPaths: body.protectedPaths, approvalTimeoutMs: body.approvalTimeoutMs }) ?? null;
  } catch {
    return null;
  }
}

/** The form a sandbox state is stored in (`kind` tells it apart from the guard rows older versions wrote). */
export function storedSandboxState(state: ForemanSandboxState): Record<string, unknown> {
  return { kind: 'sandbox', ...state };
}

const fill = (text: string, values: { cwd: string; scratch: string }): string => text.split('{cwd}').join(values.cwd).split('{scratch}').join(values.scratch);
/** A Claude Code permission-rule path for an absolute path: `//abs/path`. */
const ruleAbs = (abs: string): string => `/${abs.startsWith('/') ? abs : `/${abs}`}`;

/** The template for one session: placeholders replaced, the task's writable paths added, protected paths made unwritable. Pure (same as Foreman's `fillTemplate`). */
// Consumed by buildSandboxAdditions below and by the tests (golden parity with Foreman's policy.ts).
export function fillTemplate(template: SandboxTemplate, session: { cwd: string; scratch: string; writeDirs?: string[]; protectedPaths?: string[] }): SandboxTemplate {
  const values = { cwd: session.cwd.replace(/\/+$/, ''), scratch: session.scratch.replace(/\/+$/, '') };
  const f = (list: string[]): string[] => list.map((item) => fill(item, values));
  const protectedAbs = unique((session.protectedPaths ?? []).map((entry) => `${values.cwd}/${entry.replace(/^\/+/, '').replace(/\/+$/, '')}`));
  const writeDirs = unique((session.writeDirs ?? []).filter((dir) => dir.startsWith('/') && dir !== '/'));
  return {
    sandbox: {
      network: { allowedDomains: [...template.sandbox.network.allowedDomains], allowAllUnixSockets: template.sandbox.network.allowAllUnixSockets },
      filesystem: {
        denyRead: f(template.sandbox.filesystem.denyRead),
        allowRead: unique([...f(template.sandbox.filesystem.allowRead), ...writeDirs]),
        allowWrite: unique([...f(template.sandbox.filesystem.allowWrite), ...writeDirs]),
        denyWrite: unique([...f(template.sandbox.filesystem.denyWrite), ...protectedAbs]),
      },
      credentials: { envVars: template.sandbox.credentials.envVars.map((entry) => ({ ...entry })) },
    },
    permissions: {
      allow: f(template.permissions.allow),
      deny: unique([...f(template.permissions.deny), ...protectedAbs.flatMap((entry) => [`Edit(${ruleAbs(entry)})`, `Write(${ruleAbs(entry)})`, `NotebookEdit(${ruleAbs(entry)})`])]),
    },
    disallowedTools: [...template.disallowedTools],
    env: Object.fromEntries(Object.entries(template.env).map(([key, value]) => [key, fill(value, values)])),
  };
}

/** The SDK `sandbox` option of a run, with the load-bearing switches forced on (same as Foreman's `sdkSandboxOptions`). */
// Consumed by buildSandboxAdditions below and by the tests.
export function sdkSandboxOptions(template: SandboxTemplate): Record<string, unknown> {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { ...template.sandbox.network, strictAllowlist: true },
    filesystem: template.sandbox.filesystem,
    credentials: template.sandbox.credentials,
  };
}

/**
 * What a sandboxed run adds to its SDK options, or an error when it must not run: the policy is missing (Foreman never answered and nothing is
 * cached), malformed, or switched off. A session that was started sandboxed never runs unsandboxed because something is down.
 */
// Consumed by the runtime hooks (forSession).
export function requireSandboxAdditions(
  policy: ForemanSandboxPolicy | null | undefined,
  session: { projectPath: string | null; state: ForemanSandboxState },
  makeDir: (dir: string) => void = (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
): ForemanSandboxAdditions {
  if (!policy) {
    throw new Error('Foreman sandbox policy unavailable: this session was started sandboxed and will not run without it (Foreman is down or sent no policy). Try again when Foreman is back.');
  }
  if (!policy.enabled) {
    throw new Error('Foreman sandbox policy is switched off (workers.sandbox.enabled is false) but this session was started sandboxed: it will not run without isolation.');
  }
  if (!session.projectPath || !path.isAbsolute(session.projectPath)) {
    throw new Error('A sandboxed session needs the absolute path of its project.');
  }
  const filled = fillTemplate(policy.template, {
    cwd: session.projectPath,
    scratch: session.state.scratchDir,
    writeDirs: session.state.writeDirs,
    protectedPaths: session.state.protectedPaths,
  });
  // The CLI creates `<TMPDIR>/claude-<uid>` itself but not its parents, and it needs them before it runs the first command.
  for (const dir of [session.state.scratchDir, `${session.state.scratchDir}/tmp`, `${session.state.scratchDir}/cc`]) {
    makeDir(dir);
  }
  return { sandbox: sdkSandboxOptions(filled), permissions: filled.permissions, disallowedTools: filled.disallowedTools, env: filled.env };
}

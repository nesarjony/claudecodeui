import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { protectedWritePaths } from '@/modules/foreman/foreman-sandbox-protected.service.js';
import { sandboxScopeProblem } from '@/modules/foreman/foreman-sandbox-scope.service.js';
import type { ForemanSandboxScope } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * The sandbox of the sessions Foreman starts: isolation instead of inspection.
 *
 * Foreman owns the policy and sends it, already filled in for the task, with every session start. This file checks that it is
 * well formed and turns it into the options Claude Code understands: the SDK `sandbox` option (bubblewrap around every Bash call),
 * permission rules for the file tools (which are not sandboxed), denied tools and the CLI's environment. It reads no command and
 * judges no tool call. The switches that make a sandbox a sandbox, the denial of the tools only a person can answer, and the read-only
 * paths through which git or the CLI would run a worker's code outside the sandbox (foreman-sandbox-protected.service.ts) are forced here
 * whatever the policy says; the parts of a policy that open something up (environment, hosts, paths, allow rules) are checked against what a
 * worker may have (foreman-sandbox-scope.service.ts). A policy that is missing, malformed or too wide means the session does not start.
 */

/** What Foreman sends as `sandbox` of a session start, and what the session stores and applies on every run. */
export type ForemanSandboxPolicy = {
  /** Writable scratch space of the task; the CLI's temp directories live under it. */
  scratchDir: string;
  /** How long a prompt that still reaches Foreman waits before it is denied; null for the default. */
  approvalTimeoutMs: number | null;
  network: { allowedDomains: string[]; allowAllUnixSockets: boolean };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  credentials: { envVars: Array<{ name: string; mode: 'deny' }> };
  permissions: { allow: string[]; deny: string[] };
  disallowedTools: string[];
  /** Environment of the CLI process (not only of its commands). */
  env: Record<string, string>;
};

/** What a sandboxed run adds to its SDK options. */
export type ForemanSandboxAdditions = {
  sandbox: Record<string, unknown>;
  permissions: { allow: string[]; deny: string[] };
  disallowedTools: string[];
  env: Record<string, string>;
  approvalTimeoutMs: number;
};

export const DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

// Nobody is there to answer a question or approve a plan in an unattended run, and the prompt for either would wait without a timeout.
const UNATTENDED_DENIED_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
// On this host the sandbox only starts with every unix socket allowed (AppArmor's `unpriv_bwrap` profile; the tested workaround of Foreman's
// sandbox findings), so it is forced on whatever the policy says. Set it to false once the owner fixes the AppArmor profile.
const FORCED_ALLOW_ALL_UNIX_SOCKETS = true;
// Where the host keeps its sockets and the other users' and sessions' files. With every unix socket allowed, a socket a worker can see is one
// it can connect to, so these trees are always denied for reading, whatever the policy denies. The checkout and the scratch directory stay
// reachable: the sandbox runtime mounts the allowed paths over a denied tree. `/var/snap` holds the CUPS socket; foreman-sandbox-sockets.test.ts
// lists the sockets outside these trees (a host check, run with CLOUDCLI_HOST_CHECKS=1), so a new one fails it instead of staying reachable.
const HIDDEN_TREES = ['/run', '/tmp', '/var/tmp', '/home', '/mnt', '/media', '/srv', '/var/snap'];
// The file tools run outside the sandbox, so a protected path is denied to them by rule as well as to Bash by `denyWrite`.
const WRITING_FILE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

const MAX_ENTRIES = 400;
const MAX_ENTRY_LENGTH = 1000;
const MAX_PATH_LENGTH = 4096;
// The CLI's network bridge makes a unix socket `<scratchDir>/tmp/claude-http-<16 hex>.sock`, and a unix socket path may be 107 bytes at most. A longer
// scratch directory does not fail the session start: every Bash call then dies with "Failed to create bridge sockets". Refuse it up front.
const MAX_SCRATCH_DIR_LENGTH = 64;
const MIN_APPROVAL_TIMEOUT_MS = 1000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function invalid(message: string): AppError {
  return new AppError(`sandbox is malformed: ${message}`, { code: 'SANDBOX_INVALID', statusCode: 400 });
}

function readList(parent: Record<string, unknown>, field: string, where: string): string[] {
  const value = parent[field];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw invalid(`${where}.${field} must be an array of at most ${MAX_ENTRIES} strings.`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      throw invalid(`${where}.${field} must hold non-empty strings of at most ${MAX_ENTRY_LENGTH} characters.`);
    }
  }
  return [...new Set(value as string[])];
}

function readObject(parent: Record<string, unknown>, field: string, where: string): Record<string, unknown> {
  const value = asRecord(parent[field]);
  if (!value) {
    throw invalid(`${where}${where ? '.' : ''}${field} must be an object.`);
  }
  return value;
}

function readEnvVars(parent: Record<string, unknown>): Array<{ name: string; mode: 'deny' }> {
  const list = parent.envVars;
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) {
    throw invalid('credentials.envVars must be an array.');
  }
  return list.map((entry) => {
    const item = asRecord(entry);
    if (!item || typeof item.name !== 'string' || !ENV_NAME_PATTERN.test(item.name) || item.mode !== 'deny') {
      throw invalid('credentials.envVars entries must be { name, mode: "deny" }.');
    }
    return { name: item.name, mode: 'deny' as const };
  });
}

function readEnvironment(raw: Record<string, unknown>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(name) || typeof value !== 'string') {
      throw invalid('env must map variable names to strings.');
    }
    environment[name] = value;
  }
  return environment;
}

function readApprovalTimeout(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_APPROVAL_TIMEOUT_MS || value > MAX_APPROVAL_TIMEOUT_MS) {
    throw invalid(`approvalTimeoutMs must be an integer between ${MIN_APPROVAL_TIMEOUT_MS} and ${MAX_APPROVAL_TIMEOUT_MS} (milliseconds).`);
  }
  return value;
}

/**
 * Validates a sandbox policy for a session that works in `scope`. Absent or `null` is refused too (`SANDBOX_REQUIRED`): a session the bridge
 * starts is always sandboxed. Every part is checked for shape and size; the parts that open something up are also checked for what they open
 * (`sandboxScopeProblem`), the writable ones against the session's project and git directory. What the lists that only close things
 * (denials) say is Foreman's Charter to decide.
 */
// Consumed by foreman.routes.ts (session start) and by foreman-session-sandbox.service.ts (a stored policy is read through the same check, against the stored scope).
export function parseSandboxPolicy(raw: unknown, scope: ForemanSandboxScope): ForemanSandboxPolicy {
  if (raw === undefined || raw === null) {
    throw new AppError('sandbox is required: a session started through the bridge always runs sandboxed.', {
      code: 'SANDBOX_REQUIRED',
      statusCode: 400,
    });
  }
  const body = asRecord(raw);
  if (!body) {
    throw invalid('it must be an object.');
  }
  const { scratchDir } = body;
  if (typeof scratchDir !== 'string' || scratchDir.length > MAX_PATH_LENGTH || !path.isAbsolute(scratchDir) || path.resolve(scratchDir) === path.sep || scratchDir.includes('\0')) {
    throw invalid('scratchDir must be an absolute path other than "/".');
  }
  if (scratchDir.length > MAX_SCRATCH_DIR_LENGTH) {
    throw invalid(`scratchDir is ${scratchDir.length} characters; at most ${MAX_SCRATCH_DIR_LENGTH}, because the CLI's network bridge socket lives under it and a unix socket path is limited to 107 bytes.`);
  }
  const network = readObject(body, 'network', '');
  const filesystem = readObject(body, 'filesystem', '');
  const credentials = readObject(body, 'credentials', '');
  const permissions = readObject(body, 'permissions', '');
  const policy: ForemanSandboxPolicy = {
    scratchDir,
    approvalTimeoutMs: readApprovalTimeout(body.approvalTimeoutMs),
    network: { allowedDomains: readList(network, 'allowedDomains', 'network'), allowAllUnixSockets: network.allowAllUnixSockets === true },
    filesystem: {
      denyRead: readList(filesystem, 'denyRead', 'filesystem'),
      allowRead: readList(filesystem, 'allowRead', 'filesystem'),
      allowWrite: readList(filesystem, 'allowWrite', 'filesystem'),
      denyWrite: readList(filesystem, 'denyWrite', 'filesystem'),
    },
    credentials: { envVars: readEnvVars(credentials) },
    permissions: { allow: readList(permissions, 'allow', 'permissions'), deny: readList(permissions, 'deny', 'permissions') },
    disallowedTools: readList(body, 'disallowedTools', ''),
    env: readEnvironment(readObject(body, 'env', '')),
  };
  const problem = sandboxScopeProblem(policy, scope);
  if (problem) {
    throw new AppError(`sandbox would widen the session: ${problem}`, { code: 'SANDBOX_INVALID', statusCode: 400 });
  }
  return policy;
}

/**
 * What a run of a sandboxed session working in `scope` adds to its SDK options: the policy with the load-bearing switches forced on, every
 * unix socket allowed (FORCED_ALLOW_ALL_UNIX_SOCKETS), the trees that hold sockets hidden (HIDDEN_TREES joined to `denyRead`), and git's and
 * the CLI's own files read-only (`protectedWritePaths`, joined to `denyWrite` and to the deny rules of the file tools; what the policy already
 * carries is not repeated). Creates the scratch directories first, because the CLI makes `<TMPDIR>/claude-<uid>` itself but not its parents,
 * and needs them before its first command.
 */
// Consumed by foreman.module.ts, which hands it to the Claude runtime for every run of a sandboxed session.
export function buildSandboxAdditions(
  policy: ForemanSandboxPolicy,
  scope: ForemanSandboxScope,
  makeDirectory: (directory: string) => void = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
): ForemanSandboxAdditions {
  for (const directory of [policy.scratchDir, `${policy.scratchDir}/tmp`, `${policy.scratchDir}/cc`]) {
    makeDirectory(directory);
  }
  const forced = protectedWritePaths(scope);
  // `//` makes a rule's path absolute; a directory is denied with everything below it.
  const forcedRules = forced.flatMap((entry) => WRITING_FILE_TOOLS.map((tool) => `${tool}(/${entry.path}${entry.directory ? '/**' : ''})`));
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { ...policy.network, allowAllUnixSockets: FORCED_ALLOW_ALL_UNIX_SOCKETS, strictAllowlist: true },
      filesystem: {
        ...policy.filesystem,
        denyRead: [...new Set([...policy.filesystem.denyRead, ...HIDDEN_TREES])],
        denyWrite: [...new Set([...policy.filesystem.denyWrite, ...forced.map((entry) => entry.path)])],
      },
      credentials: policy.credentials,
    },
    permissions: { allow: policy.permissions.allow, deny: [...new Set([...policy.permissions.deny, ...forcedRules])] },
    disallowedTools: [...new Set([...policy.disallowedTools, ...UNATTENDED_DENIED_TOOLS])],
    env: policy.env,
    approvalTimeoutMs: policy.approvalTimeoutMs ?? DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS,
  };
}

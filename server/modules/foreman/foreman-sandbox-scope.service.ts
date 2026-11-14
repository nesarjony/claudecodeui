import os from 'node:os';
import path from 'node:path';

import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import { resolveCapConfig } from '@/modules/providers/index.js';

/**
 * What a sandbox policy may open up. `buildSandboxAdditions` forces the switches that make a sandbox a sandbox; the rest of a policy is
 * Foreman's to fill in, and some of it widens the session it is applied to: the CLI's environment, the hosts and paths the sandbox opens and
 * the permission rules of the file tools (which run outside the sandbox). Those parts are held here to what a worker needs, so that no policy,
 * however it was made, can reroute a session, give it the owner's home or settings, or let it reach cloudcli or claude-cap.
 */

// Variables a worker's CLI may be given. Anything else could change what the CLI loads or where it sends its requests (`NODE_OPTIONS`,
// `LD_PRELOAD`, `ANTHROPIC_*`): the routing of a session is cloudcli's, set before the policy is merged.
const ALLOWED_ENV_NAMES = [
  'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];
const SCRATCH_ENV_NAMES = new Set(['TMPDIR', 'CLAUDE_CODE_TMPDIR']);
const DEFAULT_SERVER_PORT = 3001;
// A path shallower than this is a whole tree of the host: `/`, `/mnt`, `/mnt/dev`, `/home`, `/home/<user>`.
const MIN_PATH_COMPONENTS = 3;
const GLOB = /[*?[\]{}]/;
const HOST_PORT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*):(\d{1,5})$/;
// Bash runs inside the sandbox, so allowing it outright is safe (and needed: the CLI still asks for some sandboxed commands); a narrower Bash
// rule is never needed. TodoWrite touches nothing outside the session.
const ALLOWED_BARE_RULES = new Set(['Bash', 'Bash(*)', 'Bash(:*)', 'TodoWrite']);
const PATH_RULE = /^(Read|Edit|Write|NotebookEdit)\((.*)\)$/;
const ALLOWED_MCP_RULE = /^mcp__infigraph(__[A-Za-z0-9_-]+)?$/;

/** A port nobody may open: cloudcli's own or claude-cap's (on any host, or on the cap's host when its URL names no port). */
type ProtectedPort = { port: number; host: string | null };

function protectedPorts(): ProtectedPort[] {
  const ports: ProtectedPort[] = [{ port: DEFAULT_SERVER_PORT, host: null }];
  const serverPort = Number.parseInt(process.env.SERVER_PORT ?? '', 10);
  if (Number.isInteger(serverPort)) {
    ports.push({ port: serverPort, host: null });
  }
  const cap = new URL(resolveCapConfig(process.env, () => undefined).url);
  ports.push(cap.port
    ? { port: Number(cap.port), host: null }
    : { port: cap.protocol === 'https:' ? 443 : 80, host: cap.hostname.toLowerCase() });
  return ports;
}

function environmentProblem(env: Record<string, string>, scratchDir: string): string | null {
  for (const [name, value] of Object.entries(env)) {
    if (!ALLOWED_ENV_NAMES.includes(name)) {
      return `env.${name} is not a variable a policy may set (allowed: ${ALLOWED_ENV_NAMES.join(', ')}).`;
    }
    const inside = path.posix.normalize(value) === value && (value === scratchDir || value.startsWith(`${scratchDir.replace(/\/+$/, '')}/`));
    if (SCRATCH_ENV_NAMES.has(name) && !inside) {
      return `env.${name} must be a normalised path inside scratchDir.`;
    }
  }
  return null;
}

function domainProblem(entry: string, ports: ProtectedPort[]): string | null {
  const match = HOST_PORT.exec(entry);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) {
    return `network.allowedDomains: "${entry}" must be host:port with a port (no wildcards).`;
  }
  const host = match[1].toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `network.allowedDomains: "${entry}" names localhost.`;
  }
  // Any host, not only a loopback address: a name can resolve to this machine.
  if (ports.some((item) => item.port === port && (item.host === null || item.host === host))) {
    return `network.allowedDomains: "${entry}" is on the port of cloudcli or claude-cap, which a worker never reaches.`;
  }
  return null;
}

/**
 * Why `target` (an absolute path, a glob allowed only after its fixed part) is too broad for `field`, or null. A writable path may also not
 * hold a `.claude` or `.ssh` directory or reach into git's hooks or config: those run code or grant access outside the sandbox.
 */
function pathProblem(field: string, entry: string, target: string, write: boolean): string | null {
  if (!path.posix.isAbsolute(target) || path.posix.normalize(target) !== target || target.includes('\0')) {
    return `${field}: "${entry}" must be an absolute, normalised path (no "..", "." or "//").`;
  }
  const components = target.split('/').filter(Boolean);
  const firstGlob = components.findIndex((component) => GLOB.test(component));
  const anchored = firstGlob === -1 ? components : components.slice(0, firstGlob);
  if (anchored.length < MIN_PATH_COMPONENTS) {
    return `${field}: "${entry}" is too broad: it needs at least ${MIN_PATH_COMPONENTS} path components before any wildcard.`;
  }
  const anchor = `/${anchored.join('/')}`;
  const home = os.homedir();
  if (home === anchor || home.startsWith(`${anchor}/`)) {
    return `${field}: "${entry}" is the home directory or a directory above it.`;
  }
  if (write && components.some((component) => component === '.claude' || component === '.ssh')) {
    return `${field}: "${entry}" would make a .claude or .ssh directory writable.`;
  }
  if (write && components.some((component, index) => component === '.git' && (components[index + 1] === 'hooks' || components[index + 1] === 'config'))) {
    return `${field}: "${entry}" would make git's hooks or config writable.`;
  }
  return null;
}

function allowRuleProblem(rule: string): string | null {
  if (ALLOWED_BARE_RULES.has(rule) || ALLOWED_MCP_RULE.test(rule)) {
    return null;
  }
  const match = PATH_RULE.exec(rule);
  if (!match) {
    return `permissions.allow: "${rule}" is not allowed: only Bash, TodoWrite, mcp__infigraph and Read/Edit/Write/NotebookEdit rules on an absolute //path.`;
  }
  const [, tool, pattern] = match;
  if (!pattern.startsWith('//')) {
    return `permissions.allow: "${rule}" must name an absolute path, written //path.`;
  }
  const target = pattern.slice(1);
  if (tool !== 'Read') {
    return pathProblem('permissions.allow', rule, target, true);
  }
  // A read rule may name a system tree (`//usr`), but not every path at once (`//**`, `//**/x`).
  const first = target.split('/').filter(Boolean)[0];
  if (path.posix.normalize(target) !== target || first === undefined || GLOB.test(first)) {
    return `permissions.allow: "${rule}" must name an absolute, normalised path that does not start with a wildcard.`;
  }
  return null;
}

/**
 * Why a well-formed policy would widen the session it is applied to, or null when it would not. Checked for every policy a session starts
 * with and for every stored one a run reads back, so a policy stored before a rule existed is held to it too.
 */
// Consumed by foreman-sandbox.service.ts, whose `parseSandboxPolicy` refuses such a policy as SANDBOX_INVALID.
export function sandboxScopeProblem(policy: ForemanSandboxPolicy): string | null {
  const ports = protectedPorts();
  const problems = [
    pathProblem('scratchDir', policy.scratchDir, policy.scratchDir, true),
    environmentProblem(policy.env, policy.scratchDir),
    ...policy.network.allowedDomains.map((entry) => domainProblem(entry, ports)),
    ...policy.filesystem.allowRead.map((entry) => (GLOB.test(entry) ? `filesystem.allowRead: "${entry}" must be a path, not a pattern.` : pathProblem('filesystem.allowRead', entry, entry, false))),
    ...policy.filesystem.allowWrite.map((entry) => (GLOB.test(entry) ? `filesystem.allowWrite: "${entry}" must be a path, not a pattern.` : pathProblem('filesystem.allowWrite', entry, entry, true))),
    ...policy.permissions.allow.map(allowRuleProblem),
  ];
  return problems.find((problem) => problem !== null) ?? null;
}

// Shared by the scripts that drive the Foreman test instance of cloudcli: its control, the bridge calls, and the sandbox policy built by Foreman's builder.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const REAL_HOME = homedir();
export const CONFIG_DIR = process.env.FOREMAN_NEXT_CONFIG ?? path.join(REAL_HOME, '.config/foreman-next');
export const STATE_DIR = process.env.FOREMAN_TEST_STATE ?? path.join(REAL_HOME, '.local/share/foreman-next/cloudcli-test');
/** The instance runs with a home of its own (see scripts/foreman-test-instance.sh); the real home holds the secrets the sandbox must hide. */
export const INSTANCE_HOME = path.join(STATE_DIR, 'home');
export const BASE_URL = 'http://127.0.0.1:3011';
export const CAP_URL = 'http://127.0.0.1:34817';
const LAUNCHER = path.join(ROOT, 'scripts/foreman-test-instance.sh');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const secret = (name: string) => readFileSync(path.join(CONFIG_DIR, name), 'utf8').trim();

/** Runs the launcher (`restart`, `register-project <path>`, ...) with extra environment, e.g. CLAUDE_CAP_URL or FOREMAN_EVENTS_URL. */
export function instance(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(LAUNCHER, args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

// What the launcher takes from its environment besides the model endpoint. A script that runs the instance on stand-ins for a while puts these
// back as it found them, because the instance is shared (slice 3b's Foreman points its intake at it).
const INSTANCE_SETTINGS = ['CLAUDE_CAP_PROFILE', 'FOREMAN_EVENTS_URL', 'FOREMAN_URL', 'FOREMAN_WORKTREES_DIR'];

/**
 * The environment to restart the instance with in its normal configuration: the settings the running instance has (read from the process), every
 * other one empty so that nothing of this shell leaks in, and the real claude-cap as its model endpoint.
 */
export function normalInstanceSettings(): Record<string, string> {
  const found: Record<string, string> = {};
  try {
    const pid = readFileSync(path.join(STATE_DIR, 'instance.pid'), 'utf8').trim();
    const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    if (environment.includes('FOREMAN_TEST_INSTANCE=1')) {
      for (const entry of environment) {
        const name = entry.slice(0, entry.indexOf('='));
        if (INSTANCE_SETTINGS.includes(name)) found[name] = entry.slice(name.length + 1);
      }
    }
  } catch {
    // Not running: the launcher's defaults.
  }
  return { ...Object.fromEntries(INSTANCE_SETTINGS.map((name) => [name, ''])), ...found, CLAUDE_CAP_URL: CAP_URL };
}

export type BridgeAnswer = { status: number; body: any };

export async function bridge(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<BridgeAnswer> {
  const response = await fetch(`${BASE_URL}/api/foreman${route}`, {
    method,
    headers: { authorization: `Bearer ${secret('bridge-token')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

export type BridgeEvent = { id: string; sequence: number; kind: string; payload: Record<string, any> };

/** Every event of a session, oldest first, page by page. */
export async function eventsOf(sessionId: string): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = [];
  for (;;) {
    const page = (await bridge('GET', `/sessions/${sessionId}/events?after=${events.at(-1)?.sequence ?? 0}`)).body.data as { events: BridgeEvent[]; hasMore: boolean };
    events.push(...page.events);
    if (!page.hasMore) return events;
  }
}

/** A count from the instance's database, read-only (`sqlite3` reads beside the running server). */
export function instanceDbCount(sql: string): number {
  return Number(execFileSync('sqlite3', ['-readonly', path.join(STATE_DIR, 'auth.db'), sql], { encoding: 'utf8' }).trim());
}

let keyCounter = 0;
/** A call that changes a session carries a key made up for it; a script that repeats a call passes the same key again. */
export const newKey = (what: string): string => `battery:${what}:${Date.now().toString(36)}:${(keyCounter += 1)}`;

export async function waitFor<T>(what: string, probe: () => Promise<T | null | false>, timeoutMs: number, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** claude-cap's own account of the MiniMax upstream's windows (fractions of 1), read the way the allowance gate will read them. */
export async function minimaxWindows(): Promise<{ fiveHour: number | null; weekly: number | null; fetchedAt: string | null }> {
  const state = (await (await fetch(`${CAP_URL}/state`)).json()) as { upstreams: Array<{ name: string; usage?: { fiveHour?: { pct: number }; weekly?: { pct: number }; fetchedAt?: string } }> };
  const usage = state.upstreams.find((upstream) => upstream.name === 'minimax')?.usage;
  return { fiveHour: usage?.fiveHour?.pct ?? null, weekly: usage?.weekly?.pct ?? null, fetchedAt: usage?.fetchedAt ?? null };
}

export type CapRequest = { ts: string; profile: string | null; status: number | null; prompt: string | null };

/** The requests claude-cap logged since `since` (ms) that `wanted` picks, newest first, read from its activity log page by page. */
export async function capRequestsSince(since: number, wanted: (request: CapRequest) => boolean): Promise<CapRequest[]> {
  const found: CapRequest[] = [];
  for (let offset = 0; offset < 20_000; offset += 20) {
    const page = (await (await fetch(`${CAP_URL}/state?activityOffset=${offset}`)).json()) as { activity: CapRequest[] };
    found.push(...page.activity.filter((request) => Date.parse(request.ts) >= since && wanted(request)));
    if (page.activity.length === 0 || page.activity.some((request) => Date.parse(request.ts) < since)) break;
  }
  return found;
}

/** The `sandbox` of a session start, as cloudcli takes it (docs/foreman-bridge.md, Sandbox). */
export type SandboxPolicy = {
  scratchDir: string;
  approvalTimeoutMs: number;
  network: { allowedDomains: string[]; allowAllUnixSockets: boolean };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  credentials: { envVars: Array<{ name: string; mode: 'deny' }> };
  permissions: { allow: string[]; deny: string[] };
  disallowedTools: string[];
  env: Record<string, string>;
};

type Template = {
  sandbox: Pick<SandboxPolicy, 'network' | 'filesystem' | 'credentials'>;
  permissions: SandboxPolicy['permissions'];
  disallowedTools: string[];
  env: Record<string, string>;
};
type PolicyModule = {
  DEFAULT_SANDBOX_CONFIG: Record<string, unknown> & { denyRead: string[] };
  resolveSandboxTemplate(config: Record<string, unknown>, options: { home: string }): Template;
  fillTemplate(template: Template, session: { cwd: string; scratch: string; writeDirs?: string[] }): Template;
};

/** The policy builder of the old Foreman, until slice 3b ports it; point FOREMAN_POLICY_MODULE at another one to run the same scripts against it. */
const POLICY_MODULE = process.env.FOREMAN_POLICY_MODULE ?? '/mnt/dev/frontend/foreman-wt/sandbox/src/sandbox/policy.ts';

export type PolicySession = { cwd: string; scratch: string; gitCommonDir?: string; extraReadAllow?: string[]; allowedDomains?: string[]; approvalTimeoutMs?: number };

/**
 * The `sandbox` of a session start for a task in `cwd`, and what had to change in the builder's output for cloudcli to take it. Foreman's builder makes
 * the template and fills it; the wire form is that filled template with its `sandbox` part flattened. The builder expands `~` with the home it is
 * given, and the instance's home is not the real one, so the entries that name secrets are made absolute under the real home first and the tool
 * caches and `.gitconfig` stay under the instance's.
 *
 * The adapter: what cloudcli refuses of the old builder's output is dropped, everything else is kept as built (docs/foreman-bridge.md, "What a
 * conforming policy looks like", is the list for slice 3b's builder). It adds no protection of its own: the read-only paths of git and of the
 * agent's settings are cloudcli's to force, and the battery tests that it does.
 */
export async function adaptedPolicy(session: PolicySession): Promise<{ policy: SandboxPolicy; changes: string[] }> {
  const { DEFAULT_SANDBOX_CONFIG, resolveSandboxTemplate, fillTemplate } = (await import(POLICY_MODULE)) as PolicyModule;
  const underRealHome = (entry: string) => (entry.startsWith('~') ? REAL_HOME + entry.slice(1) : entry);
  const config = {
    ...DEFAULT_SANDBOX_CONFIG,
    allowedDomains: session.allowedDomains ?? [],
    readAllow: ['~/.gitconfig', ...(session.extraReadAllow ?? [])],
    denyRead: DEFAULT_SANDBOX_CONFIG.denyRead.map(underRealHome),
  };
  const git = session.gitCommonDir;
  const filled = fillTemplate(resolveSandboxTemplate(config, { home: INSTANCE_HOME }), { cwd: session.cwd, scratch: session.scratch, writeDirs: git ? [git] : [] });
  const changes: string[] = [];
  const keep = (list: string[], allowed: (entry: string) => boolean, rule: string): string[] => {
    const dropped = list.filter((entry) => !allowed(entry));
    if (dropped.length > 0) changes.push(`${rule}: dropped ${dropped.map((entry) => `\`${entry}\``).join(', ')}`);
    return list.filter(allowed);
  };
  // cloudcli lets a policy write only the project, scratchDir and the shared git directory; the builder also opens the tool caches under HOME.
  const roots = [session.cwd, session.scratch, ...(git ? [git] : [])];
  const allowWrite = keep(filled.sandbox.filesystem.allowWrite, (entry) => roots.some((root) => entry === root || entry.startsWith(`${root}/`)),
    'writable only where the session works (the tool caches stay readable; a cache belongs in scratchDir)');
  // A read rule may not reach a secret; `/etc` holds claude-cap's environment file with its upstream keys.
  const allow = keep(filled.permissions.allow, (rule) => !/^Read\(\/\/etc(\/\*\*)?\)$/.test(rule), 'no read rule on a tree that holds a secret (/etc holds /etc/claude-cap.env)');
  // The CLI makes every Edit/Write deny a read-only mount, and a read-only `.git` cannot take a commit; cloudcli forces what of it must stay read-only.
  const deny = keep(filled.permissions.deny, (rule) => !/^(Edit|Write|NotebookEdit)\(.*\/\.git\/\*\*\)$/.test(rule), 'no write deny on a whole .git (a commit needs it writable)');
  if (git) {
    // A rule's absolute path is `//path`: one slash before an absolute path, not two (`///path` is refused as not normalised).
    allow.push(`Read(/${git}/**)`);
    changes.push(`the worktree's git directory readable by the file tools: added \`Read(/${git}/**)\``);
  }
  return {
    policy: {
      scratchDir: session.scratch,
      approvalTimeoutMs: session.approvalTimeoutMs ?? 120_000,
      network: filled.sandbox.network,
      filesystem: { ...filled.sandbox.filesystem, allowWrite },
      credentials: filled.sandbox.credentials,
      permissions: { allow, deny },
      disallowedTools: filled.disallowedTools,
      env: filled.env,
    },
    changes,
  };
}

export async function buildPolicy(session: PolicySession): Promise<SandboxPolicy> {
  return (await adaptedPolicy(session)).policy;
}

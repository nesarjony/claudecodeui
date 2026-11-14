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
const LAUNCHER = path.join(ROOT, 'scripts/foreman-test-instance.sh');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const secret = (name: string) => readFileSync(path.join(CONFIG_DIR, name), 'utf8').trim();

/** Runs the launcher (`restart`, `register-project <path>`, ...) with extra environment, e.g. CLAUDE_CAP_URL or FOREMAN_EVENTS_URL. */
export function instance(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(LAUNCHER, args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
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
  const state = (await (await fetch('http://127.0.0.1:34817/state')).json()) as { upstreams: Array<{ name: string; usage?: { fiveHour?: { pct: number }; weekly?: { pct: number }; fetchedAt?: string } }> };
  const usage = state.upstreams.find((upstream) => upstream.name === 'minimax')?.usage;
  return { fiveHour: usage?.fiveHour?.pct ?? null, weekly: usage?.weekly?.pct ?? null, fetchedAt: usage?.fetchedAt ?? null };
}

type PolicyModule = {
  DEFAULT_SANDBOX_CONFIG: Record<string, any>;
  resolveSandboxTemplate(config: Record<string, any>, options: { home: string }): any;
  fillTemplate(template: any, session: { cwd: string; scratch: string; writeDirs?: string[]; protectedPaths?: string[] }): any;
};

/** The policy builder of the old Foreman, until slice 3b ports it; point FOREMAN_POLICY_MODULE at another one to run the same scripts against it. */
const POLICY_MODULE = process.env.FOREMAN_POLICY_MODULE ?? '/mnt/dev/frontend/foreman-wt/sandbox/src/sandbox/policy.ts';

/**
 * The `sandbox` of a session start for a task in `cwd`. Foreman's builder makes the template and fills it; the wire form is that
 * filled template with its `sandbox` part flattened. The builder expands `~` with the home it is given, and the instance's home is
 * not the real one, so the entries that name secrets are made absolute under the real home first and the tool caches and
 * `.gitconfig` stay under the instance's.
 *
 * Two things the builder of the old Foreman does not know, which the policy of a worker that commits needs:
 * - The CLI turns every Edit/Write deny rule into a read-only mount in the sandbox. The builder denies `.git/**` of the checkout, which makes git unable to write
 *   its index, objects and refs: a commit fails with "Read-only file system". Only what must stay protected is denied: `.git/hooks` and `.git/config`.
 * - A worktree keeps its git directory in the main repository (`gitCommonDir`): it is opened to Bash for writing, with hooks and config kept read-only, and readable by the file tools.
 */
export async function buildPolicy(session: { cwd: string; scratch: string; gitCommonDir?: string; extraReadAllow?: string[]; allowedDomains?: string[]; approvalTimeoutMs?: number }) {
  const { DEFAULT_SANDBOX_CONFIG, resolveSandboxTemplate, fillTemplate } = (await import(POLICY_MODULE)) as PolicyModule;
  const underRealHome = (entry: string) => (entry.startsWith('~') ? REAL_HOME + entry.slice(1) : entry);
  const config = {
    ...DEFAULT_SANDBOX_CONFIG,
    allowedDomains: session.allowedDomains ?? [],
    readAllow: ['~/.gitconfig', ...(session.extraReadAllow ?? [])],
    writeAllow: [],
    denyRead: (DEFAULT_SANDBOX_CONFIG.denyRead as string[]).map(underRealHome),
  };
  const git = session.gitCommonDir;
  const filled = fillTemplate(resolveSandboxTemplate(config, { home: INSTANCE_HOME }), { cwd: session.cwd, scratch: session.scratch, writeDirs: git ? [git] : [] });
  const protectedGit = (dir: string) => ['hooks/**', 'config'].flatMap((tail) => ['Edit', 'Write'].map((tool) => `${tool}(//${dir}/${tail})`));
  filled.permissions.deny = [...filled.permissions.deny.filter((rule: string) => !/^(Edit|Write|NotebookEdit)\(.*\/\.git\/\*\*\)$/.test(rule)), ...protectedGit(`${session.cwd}/.git`)];
  if (git) {
    filled.sandbox.filesystem.denyWrite.push(`${git}/hooks`, `${git}/config`);
    filled.permissions.allow.push(`Read(//${git}/**)`);
    filled.permissions.deny.push(...protectedGit(git));
  }
  return {
    scratchDir: session.scratch,
    approvalTimeoutMs: session.approvalTimeoutMs ?? 120_000,
    ...filled.sandbox,
    permissions: filled.permissions,
    disallowedTools: filled.disallowedTools,
    env: filled.env,
  };
}

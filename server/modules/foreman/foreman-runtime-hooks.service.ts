import path from 'node:path';

import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import { resolveForemanBaseUrl } from '@/modules/foreman/foreman-suggestions.service.js';

/** What Foreman's `GET /foreman/runtime-config` tells cloudcli: the repos it manages and the hook settings. */
type ForemanRuntimeConfig = {
  repos: Array<{ name: string; path: string }>;
  workerAutoCompactPct: number;
  hooks: { enabled: boolean; preCompactBudgetMs: number; sessionStartMaxChars: number };
};

/** One SDK hook callback: it gets the hook input and answers with the hook's JSON output. It must never throw. */
type RuntimeHookCallback = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** The SDK's `hooks` option entry for one event. */
type RuntimeHookMatcher = { matcher?: string; hooks: RuntimeHookCallback[]; timeout?: number };

/**
 * What the Foreman bridge adds to a Claude run: in-process hooks for the events Foreman cares about and environment
 * variables for the CLI. The runtime merges both into the SDK options of the run.
 */
// Consumed by the Claude runtime provider (through providers/index.ts), which merges it into each run's SDK options.
export type ClaudeRuntimeAdditions = {
  env?: Record<string, string>;
  hooks?: Partial<Record<'PreCompact' | 'SessionStart', RuntimeHookMatcher[]>>;
};

/** The session a run belongs to, as the runtime knows it (the stable app session id, not the CLI's own id). */
// Consumed by the Claude runtime provider when it asks for a run's additions.
export type ClaudeRuntimeSession = { sessionId: string; projectPath: string | null };

type RuntimeHooksDependencies = {
  tokenFile: string;
  /** Foreman's origin. Defaults to `FOREMAN_URL`, then the origin of `FOREMAN_EVENTS_URL`, then Foreman's local address. */
  baseUrl?: string;
  /** Was this session started through the Foreman bridge? Only those get the autocompact threshold. */
  isManagedSession: (sessionId: string) => boolean;
  fetchImpl?: typeof fetch;
  /** How long a fetched config is trusted before it is fetched again (stale config is used while Foreman is down). */
  configTtlMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  /** Verbose log, on only with `FOREMAN_BRIDGE_DEBUG`: one line per hook call and what Foreman answered. */
  debug?: (message: string) => void;
};

const DEFAULT_CONFIG_TTL_MS = 30_000;
const CONFIG_TIMEOUT_MS = 1_500;
const SESSION_START_TIMEOUT_MS = 6_000;
const PRE_COMPACT_SLACK_MS = 4_000;
/** The autocompact percentage when Foreman cannot be asked (its config default). */
const DEFAULT_AUTOCOMPACT_PCT = 70;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Is `projectPath` the repo root or anything below it? Boundary aware: `/a/desk-old` is not under `/a/desk`. */
function isInsideRepo(projectPath: string, repoPath: string): boolean {
  const project = path.resolve(projectPath);
  const root = path.resolve(repoPath);
  return project === root || project.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** Narrows Foreman's answer to the config shape, or null when it is not one. */
function parseRuntimeConfig(value: unknown): ForemanRuntimeConfig | null {
  const body = asRecord(value);
  const hooks = asRecord(body?.hooks);
  if (!body || !hooks || !Array.isArray(body.repos) || typeof body.workerAutoCompactPct !== 'number') {
    return null;
  }
  const repos = body.repos.flatMap((repo) => {
    const r = asRecord(repo);
    return r && typeof r.name === 'string' && typeof r.path === 'string' ? [{ name: r.name, path: r.path }] : [];
  });
  return {
    repos,
    workerAutoCompactPct: Math.min(99, Math.max(1, Math.round(body.workerAutoCompactPct))),
    hooks: {
      enabled: hooks.enabled === true,
      preCompactBudgetMs: typeof hooks.preCompactBudgetMs === 'number' ? hooks.preCompactBudgetMs : 20_000,
      sessionStartMaxChars: typeof hooks.sessionStartMaxChars === 'number' ? hooks.sessionStartMaxChars : 6_000,
    },
  };
}

/**
 * Decides, per Claude run, what the Foreman bridge adds to it, and builds the hooks.
 *
 * - Hooks (`PreCompact`, `SessionStart`) are added only for sessions inside a repo Foreman manages (its config `repos`, read
 *   from Foreman and cached). `PreCompact` asks Foreman to write the session's notes and appends its instructions to the
 *   compaction; `SessionStart` hands the notes back after a compaction (or on resuming a handed-off session).
 * - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is added only for sessions started through the bridge.
 * - Nothing here can break a session: every call has a strict timeout, any failure (Foreman down, slow, refusing) makes a hook a
 *   no-op, and nothing touches `~/.claude/settings.json` or any other user-level hook configuration.
 */
// Consumed by foreman.module.ts, which registers it with the Claude runtime.
export function createForemanRuntimeHooks(dependencies: RuntimeHooksDependencies) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const ttlMs = dependencies.configTtlMs ?? DEFAULT_CONFIG_TTL_MS;
  const warn = dependencies.warn ?? (() => undefined);
  const debug = dependencies.debug ?? (() => undefined);
  let cached: { config: ForemanRuntimeConfig; fetchedAt: number } | null = null;
  let inflight: Promise<ForemanRuntimeConfig | null> | null = null;
  // After a failed first fetch (Foreman down), do not make every run start wait for the timeout again.
  let retryNotBefore = 0;

  async function call(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const token = await readBridgeToken(dependencies.tokenFile);
    if (!token) {
      return null;
    }
    try {
      const response = await fetchImpl(`${resolveForemanBaseUrl(dependencies.baseUrl)}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok ? asRecord(await response.json()) : null;
    } catch {
      return null;
    }
  }

  /** Foreman's runtime config: fresh within the TTL, else refetched; the last good one is kept when Foreman cannot be reached. */
  async function loadConfig(): Promise<ForemanRuntimeConfig | null> {
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.config;
    }
    if (!cached && now() < retryNotBefore) {
      return null;
    }
    inflight ??= call('GET', '/foreman/runtime-config', undefined, CONFIG_TIMEOUT_MS)
      .then((body) => {
        const config = parseRuntimeConfig(body);
        if (config) {
          cached = { config, fetchedAt: now() };
        } else if (!cached) {
          retryNotBefore = now() + 5_000;
        } else if (cached) {
          // Foreman is down or answered nonsense: keep the stale config, and ask again after a short pause.
          cached = { ...cached, fetchedAt: now() - ttlMs + 5_000 };
        }
        return cached?.config ?? null;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function buildHooks(session: ClaudeRuntimeSession, config: ForemanRuntimeConfig): NonNullable<ClaudeRuntimeAdditions['hooks']> {
    const preCompact: RuntimeHookCallback = async (input) => {
      try {
        const hook = asRecord(input);
        if (hook?.hook_event_name !== 'PreCompact') {
          return {};
        }
        const answer = await call(
          'POST',
          '/foreman/hooks/pre-compact',
          {
            sessionId: session.sessionId,
            trigger: hook.trigger === 'auto' ? 'auto' : 'manual',
            ...(typeof hook.custom_instructions === 'string' && hook.custom_instructions ? { customInstructions: hook.custom_instructions } : {}),
            ...(session.projectPath ? { projectPath: session.projectPath } : {}),
          },
          config.hooks.preCompactBudgetMs + PRE_COMPACT_SLACK_MS,
        );
        const instructions = typeof answer?.instructions === 'string' ? answer.instructions.trim() : '';
        debug(`PreCompact hook session=${session.sessionId} trigger=${String(hook.trigger)}: Foreman ${answer ? `answered notes v${String(answer.notesVersion ?? '-')}, ${instructions.length} chars of instructions` : 'did not answer'}`);
        // The CLI appends a PreCompact hook's `systemMessage` to the compaction instructions.
        return instructions ? { systemMessage: instructions } : {};
      } catch (error) {
        warn(`Foreman PreCompact hook failed: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    };

    const sessionStart: RuntimeHookCallback = async (input) => {
      try {
        const hook = asRecord(input);
        if (hook?.hook_event_name !== 'SessionStart' || (hook.source !== 'compact' && hook.source !== 'resume')) {
          return {};
        }
        const answer = await call(
          'POST',
          '/foreman/hooks/session-start',
          { sessionId: session.sessionId, source: hook.source, ...(session.projectPath ? { projectPath: session.projectPath } : {}) },
          SESSION_START_TIMEOUT_MS,
        );
        const context = typeof answer?.additionalContext === 'string' ? answer.additionalContext : '';
        debug(`SessionStart hook session=${session.sessionId} source=${String(hook.source)}: Foreman ${answer ? `answered ${context.length} chars of notes` : 'did not answer'}`);
        return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {};
      } catch (error) {
        warn(`Foreman SessionStart hook failed: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    };

    return {
      // `timeout` is in seconds and covers the hook's own wait on Foreman, with room for the call's overhead.
      PreCompact: [{ matcher: '', hooks: [preCompact], timeout: Math.ceil((config.hooks.preCompactBudgetMs + PRE_COMPACT_SLACK_MS) / 1000) + 3 }],
      SessionStart: [{ matcher: '', hooks: [sessionStart], timeout: Math.ceil(SESSION_START_TIMEOUT_MS / 1000) + 2 }],
    };
  }

  return {
    /** What to add to the run of `session`; an empty object when Foreman has nothing to add. Never throws. */
    async forSession(session: ClaudeRuntimeSession): Promise<ClaudeRuntimeAdditions> {
      try {
        const additions: ClaudeRuntimeAdditions = {};
        const config = await loadConfig();
        if (dependencies.isManagedSession(session.sessionId)) {
          additions.env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(config?.workerAutoCompactPct ?? DEFAULT_AUTOCOMPACT_PCT) };
        }
        const managedRepo =
          config?.hooks.enabled === true && session.projectPath !== null && config.repos.some((repo) => isInsideRepo(session.projectPath as string, repo.path));
        if (config && managedRepo) {
          additions.hooks = buildHooks(session, config);
        }
        return additions;
      } catch (error) {
        warn(`Foreman runtime hooks skipped: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    },
  };
}

export type ForemanRuntimeHooks = ReturnType<typeof createForemanRuntimeHooks>;

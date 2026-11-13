import path from 'node:path';

import { readBridgeToken } from '@/modules/foreman/foreman-auth.service.js';
import {
  DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS,
  parseSandboxPolicy,
  requireSandboxAdditions,
  type ForemanSandboxPolicy,
  type ForemanSandboxState,
} from '@/modules/foreman/foreman-sandbox.service.js';
import { resolveForemanBaseUrl } from '@/modules/foreman/foreman-suggestions.service.js';

/** One subagent Foreman lets its workers delegate to (an entry of the runtime config's `delegation.agents`). */
type ForemanDelegatedAgent = {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  /**
   * Regex sources one Bash command of this agent must match (case-insensitive, against the whole trimmed command). Not an SDK
   * field: cloudcli enforces it with a PreToolUse hook. Absent on an agent that has Bash means it may run no command at all.
   */
  bashAllow?: string[];
  maxTurns?: number;
};

/** What Foreman tells cloudcli about its worker sessions (the runtime config's `workers`). */
type ForemanWorkersConfig = {
  /**
   * The model to retry on when the run's model refuses a request: `models` maps a primary model id to its fallback. Keys are
   * stored normalized (see `modelKey`), values as Foreman sent them (trimmed).
   */
  refusalFallback: { enabled: boolean; models: Record<string, string> };
  /** Tools (or tool patterns) a worker may never use, whatever its permission mode. */
  disallowedTools: string[];
  /** The sandbox policy of worker sessions (a template Foreman fills per session, see foreman-sandbox.service.ts); absent when Foreman sent none or a malformed one. */
  sandbox?: ForemanSandboxPolicy;
};

/** What Foreman's `GET /foreman/runtime-config` tells cloudcli: the repos it manages and the hook settings. */
type ForemanRuntimeConfig = {
  repos: Array<{ name: string; path: string }>;
  workerAutoCompactPct: number;
  hooks: { enabled: boolean; preCompactBudgetMs: number; sessionStartMaxChars: number };
  /** The subagents of bridge-started sessions; absent when Foreman sent none or sent a malformed one. */
  delegation?: { enabled: boolean; agents: Record<string, ForemanDelegatedAgent> };
  /** The refusal fallback and denied tools of bridge-started sessions; absent when Foreman sent none or sent a malformed one. */
  workers?: ForemanWorkersConfig;
};

/** The SDK's `AgentDefinition` as the bridge fills it (`bashAllow` stays behind: the SDK does not know it). */
// Consumed by the Claude runtime provider, which merges these into the run's `agents` option.
export type SdkAgentDefinition = { description: string; prompt: string; tools: string[]; model: string; maxTurns?: number };

/** One SDK hook callback: it gets the hook input and answers with the hook's JSON output. It must never throw. */
type RuntimeHookCallback = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** The SDK's `hooks` option entry for one event. */
type RuntimeHookMatcher = { matcher?: string; hooks: RuntimeHookCallback[]; timeout?: number };

/**
 * What the Foreman bridge adds to a Claude run: in-process hooks for the events Foreman cares about, environment variables
 * for the CLI, subagents, a refusal fallback model and denied tools. The runtime merges them into the SDK options of the run.
 */
// Consumed by the Claude runtime provider (through providers/index.ts), which merges it into each run's SDK options.
export type ClaudeRuntimeAdditions = {
  env?: Record<string, string>;
  hooks?: Partial<Record<'PreCompact' | 'SessionStart' | 'PreToolUse', RuntimeHookMatcher[]>>;
  /** Subagents the run's main agent may launch (bridge-started sessions only); merged into the SDK's `agents` option. */
  agents?: Record<string, SdkAgentDefinition>;
  /** The model the run retries on when its own model refuses a request (bridge-started sessions only); the SDK's `fallbackModel`. */
  fallbackModel?: string;
  /** Tools the run may never use (bridge-started sessions only); merged into the SDK's `disallowedTools`, which a person cannot override. */
  disallowedTools?: string[];
  /** The SDK `sandbox` option of a sandboxed session (bridge-started sessions that were started with a sandbox). */
  sandbox?: Record<string, unknown>;
  /** Permission rules of a sandboxed session, merged into the run's flag settings. */
  permissions?: { allow: string[]; deny: string[] };
  /** How long a prompt that still reaches a person waits (sandboxed sessions). */
  approvalTimeoutMs?: number;
  /** Set instead of everything else when a sandboxed session cannot be sandboxed right now: the run must not start. */
  refuse?: string;
};

/**
 * The session a run belongs to, as the runtime knows it (the stable app session id, not the CLI's own id). `model` is the
 * run's SDK model (without the `@api` marker); the refusal fallback is chosen by it.
 */
// Consumed by the Claude runtime provider when it asks for a run's additions.
export type ClaudeRuntimeSession = { sessionId: string; projectPath: string | null; model?: string };

type RuntimeHooksDependencies = {
  tokenFile: string;
  /** Foreman's origin. Defaults to `FOREMAN_URL`, then the origin of `FOREMAN_EVENTS_URL`, then Foreman's local address. */
  baseUrl?: string;
  /** Was this session started through the Foreman bridge? Only those get the autocompact threshold, the subagents, the refusal fallback and the denied tools. */
  isManagedSession: (sessionId: string) => boolean;
  /** The sandbox state of a session started sandboxed (null for any other): such a run never starts without its sandbox. */
  sandboxFor?: (sessionId: string) => ForemanSandboxState | null;
  /**
   * Is this project path a worktree the bridge created (or inside one)? Such a worktree lives outside the configured repos but
   * gets their PreCompact/SessionStart hooks. Without it only the configured repos count.
   */
  isForemanWorktree?: (projectPath: string) => boolean;
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
// In seconds, like every hook `timeout`; the subagent Bash rule is a local check with no I/O.
const SUBAGENT_BASH_HOOK_TIMEOUT_S = 5;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Is `projectPath` the repo root or anything below it? Boundary aware: `/a/desk-old` is not under `/a/desk`. */
function isInsideRepo(projectPath: string, repoPath: string): boolean {
  const project = path.resolve(projectPath);
  const root = path.resolve(repoPath);
  return project === root || project.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

// The suffix that marks the 1M-context variant of a model id; it does not make a different model for the fallback map.
const ONE_MILLION_CONTEXT_SUFFIX = /\[1m\]$/i;

/** A model id as the fallback map compares it: trimmed, without a trailing `[1m]`, lower case. */
const modelKey = (model: string): string => model.trim().replace(ONE_MILLION_CONTEXT_SUFFIX, '').trim().toLowerCase();

// Agent names as the CLI shows them to the model (Foreman's own schema is stricter: lower case).
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** One `delegation.agents` entry, or null when it is malformed (it is then left out; the other agents still apply). */
function parseDelegatedAgent(value: unknown): ForemanDelegatedAgent | null {
  const agent = asRecord(value);
  if (!agent || !isText(agent.description) || !isText(agent.prompt) || !isText(agent.model) || !isStringList(agent.tools)) {
    return null;
  }
  // A malformed allow-list drops the agent rather than reading as "no list", which would quietly change what it may run.
  if (agent.bashAllow !== undefined && !isStringList(agent.bashAllow)) {
    return null;
  }
  const maxTurns = typeof agent.maxTurns === 'number' && Number.isInteger(agent.maxTurns) && agent.maxTurns > 0 ? agent.maxTurns : undefined;
  return {
    description: agent.description,
    prompt: agent.prompt,
    tools: agent.tools,
    model: agent.model,
    ...(agent.bashAllow !== undefined ? { bashAllow: agent.bashAllow } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

/** The config's optional `delegation`; a malformed one is ignored (undefined), never fatal for the rest of the config. */
function parseDelegation(value: unknown): ForemanRuntimeConfig['delegation'] {
  const delegation = asRecord(value);
  const agents = asRecord(delegation?.agents);
  if (!delegation || typeof delegation.enabled !== 'boolean' || !agents) {
    return undefined;
  }
  const parsed: Record<string, ForemanDelegatedAgent> = {};
  for (const [name, raw] of Object.entries(agents)) {
    const agent = AGENT_NAME_PATTERN.test(name) ? parseDelegatedAgent(raw) : null;
    if (agent) {
      parsed[name] = agent;
    }
  }
  return { enabled: delegation.enabled, agents: parsed };
}

/** The config's optional `workers.refusalFallback`; undefined when it is malformed (the fallback is then off). Never fatal. */
function parseRefusalFallback(value: unknown): ForemanWorkersConfig['refusalFallback'] | undefined {
  const fallback = asRecord(value);
  if (!fallback || typeof fallback.enabled !== 'boolean') {
    return undefined;
  }
  const models: Record<string, string> = {};
  for (const [primary, target] of Object.entries(asRecord(fallback.models) ?? {})) {
    // An entry needs both ends; a half entry is left out and the others still apply.
    if (isText(target) && modelKey(primary)) {
      models[modelKey(primary)] = target.trim();
    }
  }
  return { enabled: fallback.enabled, models };
}

/** The config's optional `workers`; a malformed one is ignored (undefined), never fatal for the rest of the config. */
function parseWorkers(value: unknown): ForemanWorkersConfig | undefined {
  const workers = asRecord(value);
  if (!workers) {
    return undefined;
  }
  const disallowedTools = Array.isArray(workers.disallowedTools)
    ? [...new Set(workers.disallowedTools.filter(isText).map((tool) => tool.trim()))]
    : [];
  const sandbox = parseSandboxPolicy(workers.sandbox);
  return { refusalFallback: parseRefusalFallback(workers.refusalFallback) ?? { enabled: false, models: {} }, disallowedTools, ...(sandbox ? { sandbox } : {}) };
}

/**
 * The model to retry on after a refusal of `model`, or null: the fallback must be enabled, the model (compared by `modelKey`)
 * must have a map entry, and that entry must be a different model than the model itself.
 */
function refusalFallbackFor(fallback: ForemanWorkersConfig['refusalFallback'], model: string | undefined): string | null {
  if (!fallback.enabled || typeof model !== 'string') {
    return null;
  }
  const key = modelKey(model);
  const target = key && Object.hasOwn(fallback.models, key) ? fallback.models[key] : undefined;
  return target && modelKey(target) !== key ? target : null;
}

// `;`, `|`, `&`, `<`, `>`, a backtick, `$(` and line breaks: anything that chains, pipes, redirects or substitutes.
const SHELL_CONTROL = /[;|&<>`\r\n]|\$\(/;
// Merges stderr into the output the agent reads, which is how test runners are usually called; it is not judged.
const TRAILING_STDERR_MERGE = /\s+2>&1$/;

/**
 * May a subagent run this Bash command under its allow-list? Only a single command: no shell control operators at all (a
 * trailing `2>&1` is tolerated and ignored), and the whole trimmed command must match one of the regex sources
 * (case-insensitively, anchored at its start so a source can never match in the middle of a command). A source that is not a
 * valid regular expression matches nothing; an empty list allows nothing.
 */
// Consumed by the subagent Bash hook below and by the runtime hooks tests.
export function isAllowedSubagentBash(command: string, allow: readonly string[]): boolean {
  const trimmed = command.trim().replace(TRAILING_STDERR_MERGE, '').trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed)) {
    return false;
  }
  return allow.some((source) => {
    try {
      return new RegExp(`^(?:${source})`, 'i').test(trimmed);
    } catch {
      return false;
    }
  });
}

/** Can this agent call Bash at all? An empty list inherits every tool from the parent, Bash included. */
const hasBashTool = (tools: readonly string[]) =>
  tools.length === 0 || tools.some((tool) => tool === 'Bash' || tool === '*' || tool.startsWith('Bash('));

/**
 * The PreToolUse hook (matcher `Bash`) that keeps each configured subagent to the commands its `bashAllow` names. The real CLI
 * does not do this by itself: a `Bash(npm test:*)` entry in an agent's `tools` did not stop that agent from running
 * `touch file` (Claude Code 2.1.286). Only calls from inside a configured agent that has Bash are judged (the hook input's
 * `agent_type` names it); the main worker (no `agent_type`) and agents Foreman did not configure are left alone. An agent with
 * Bash but no allow-list may run nothing (fail closed). A refusal is a `deny`, which holds in every permission mode; the guard's
 * own hook still runs next to this one. Never throws.
 */
function subagentBashHook(agents: Record<string, ForemanDelegatedAgent>): RuntimeHookCallback {
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
  return async (input) => {
    const hook = asRecord(input);
    const agentType = typeof hook?.agent_type === 'string' ? hook.agent_type : null;
    if (!hook || hook.tool_name !== 'Bash' || !agentType || !Object.hasOwn(agents, agentType)) {
      return {};
    }
    try {
      const agent = agents[agentType];
      if (!hasBashTool(agent.tools)) {
        return {};
      }
      if (!agent.bashAllow) {
        return deny(`${agentType} may only run the commands Foreman allows it, and Foreman allows it none: Bash is denied for this agent.`);
      }
      const toolInput = asRecord(hook.tool_input);
      const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
      if (isAllowedSubagentBash(command, agent.bashAllow)) {
        return {};
      }
      return deny(
        `${agentType} may only run single commands its allow-list permits (no ;, |, &, <, >, backticks, $( or line breaks): `
        + `"${command.trim().slice(0, 200)}" is not one of them. Report what you were asked to run instead of working around it.`,
      );
    } catch {
      return deny(`${agentType} may only run commands Foreman allows it; this one could not be checked, so it was denied.`);
    }
  };
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
  const delegation = parseDelegation(body.delegation);
  const workers = parseWorkers(body.workers);
  return {
    ...(delegation ? { delegation } : {}),
    ...(workers ? { workers } : {}),
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
 *   from Foreman and cached) or inside a worktree the bridge created for a task. `PreCompact` asks Foreman to write the
 *   session's notes and appends its instructions to the compaction; `SessionStart` hands the notes back after a compaction
 *   (or on resuming a handed-off session).
 * - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is added only for sessions started through the bridge.
 * - Subagents (`agents`, from the config's `delegation`) are added only for sessions started through the bridge, with a
 *   PreToolUse hook that keeps each agent's Bash to its `bashAllow` commands.
 * - A refusal fallback model (`fallbackModel`, from the config's `workers.refusalFallback`, chosen by the run's model) and the
 *   denied tools (`disallowedTools`, from `workers.disallowedTools`) are added only for sessions started through the bridge.
 *   An armed fallback comes with `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL`: Claude Code 2.1.286 has no category route for the
 *   `reasoning_extraction` refusal, so without it the fallback model would never be used for that category.
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
      const sandboxState = dependencies.sandboxFor?.(session.sessionId) ?? null;
      try {
        const additions: ClaudeRuntimeAdditions = {};
        const config = await loadConfig();
        const managed = dependencies.isManagedSession(session.sessionId);
        if (managed) {
          additions.env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(config?.workerAutoCompactPct ?? DEFAULT_AUTOCOMPACT_PCT) };
        }
        // A person's own chat gets neither of these, nor does a bridge session when Foreman is down or sent no `workers`.
        const workers = managed ? config?.workers : undefined;
        if (workers) {
          const fallbackModel = refusalFallbackFor(workers.refusalFallback, session.model);
          if (fallbackModel) {
            additions.fallbackModel = fallbackModel;
            additions.env = { ...additions.env, CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '1' };
          }
          if (workers.disallowedTools.length > 0) {
            additions.disallowedTools = [...workers.disallowedTools];
          }
        }
        const managedRepo =
          config?.hooks.enabled === true && session.projectPath !== null && (
            config.repos.some((repo) => isInsideRepo(session.projectPath as string, repo.path))
            // A worktree the bridge made for a task sits outside the repos but is worked on like one of them.
            || dependencies.isForemanWorktree?.(session.projectPath) === true
          );
        if (config && managedRepo) {
          additions.hooks = buildHooks(session, config);
        }
        // Subagents only for sessions started through the bridge, always together with the hook that keeps their Bash to the
        // allowed commands (a run that has the agents also has the rule).
        const delegation = config?.delegation;
        if (delegation?.enabled && Object.keys(delegation.agents).length > 0 && managed) {
          additions.agents = Object.fromEntries(Object.entries(delegation.agents).map(([name, agent]) => [name, {
            description: agent.description,
            prompt: agent.prompt,
            tools: agent.tools,
            model: agent.model,
            ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
          }]));
          additions.hooks = {
            ...additions.hooks,
            PreToolUse: [{ matcher: 'Bash', hooks: [subagentBashHook(delegation.agents)], timeout: SUBAGENT_BASH_HOOK_TIMEOUT_S }],
          };
        }
        // A session started sandboxed never runs without its sandbox: a missing or switched-off policy refuses the run (see requireSandboxAdditions).
        if (sandboxState) {
          try {
            const sandbox = requireSandboxAdditions(config?.workers?.sandbox, { projectPath: session.projectPath, state: sandboxState });
            additions.sandbox = sandbox.sandbox;
            additions.permissions = sandbox.permissions;
            additions.env = { ...additions.env, ...sandbox.env };
            additions.disallowedTools = [...new Set([...(additions.disallowedTools ?? []), ...sandbox.disallowedTools])];
            additions.approvalTimeoutMs = sandboxState.approvalTimeoutMs ?? DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS;
          } catch (error) {
            return { refuse: error instanceof Error ? error.message : String(error) };
          }
        }
        return additions;
      } catch (error) {
        warn(`Foreman runtime hooks skipped: ${error instanceof Error ? error.message : String(error)}`);
        return sandboxState ? { refuse: `The sandbox of this session could not be set up (${error instanceof Error ? error.message : String(error)}), so it does not run.` } : {};
      }
    },
  };
}

export type ForemanRuntimeHooks = ReturnType<typeof createForemanRuntimeHooks>;

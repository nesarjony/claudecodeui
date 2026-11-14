/**
 * The sandbox half of the Claude runtime.
 *
 * A session that must run isolated (the Foreman bridge's workers) has a sandbox policy that the runtime folds into the SDK options of every
 * run. That logic lives here, apart from the 1800-line runtime provider, because it is the part that has to be right for a session to be
 * isolated at all: it is small, typed and tested on its own, and a later change to it cannot be lost in the provider's streaming code.
 *
 * Nothing in this file reads the provider's environment-time constants (the tool approval window is read when the provider loads, and the
 * tests set it before importing the provider), so the helpers here are either module state set by the Foreman bridge or pure functions.
 */

/**
 * What the runtime's additions provider may add to a run: extra SDK hooks, environment variables, subagents, the model to retry on after a
 * refusal and tools the run may never use, plus, for a sandboxed run, the SDK `sandbox` option, the permission rules to merge into the flag
 * settings and the window a permission prompt waits.
 */
// Consumed by claude-runtime.provider.js (its JSDoc types for the additions it resolves and folds into a run's SDK options).
export type RuntimeAdditions = {
  env?: Record<string, string>;
  hooks?: Record<string, unknown[]>;
  agents?: Record<string, { description: string; prompt: string; tools: string[]; model: string; maxTurns?: number }>;
  fallbackModel?: string;
  disallowedTools?: string[];
  sandbox?: Record<string, unknown>;
  permissions?: { allow?: string[]; deny?: string[] };
  approvalTimeoutMs?: number;
};

/** The sandbox a session's run is to apply: its additions, with the SDK `sandbox` option always present. */
// Consumed by claude-runtime.provider.js, which folds it into the run with `withSandbox`.
export type RuntimeSandbox = RuntimeAdditions & { sandbox: Record<string, unknown> };

/** What the sandbox provider answers when a session's run must not start: its stored policy is missing, unreadable or malformed. */
export type RuntimeSandboxRefusal = { refuse: string };

/**
 * The sandbox provider the Foreman bridge registers. It answers synchronously for an app session id: `null` for a session without a sandbox,
 * a refusal when the run must not start, or the sandbox to apply.
 */
export type RuntimeSandboxProvider = (sessionId: string) => RuntimeSandboxRefusal | RuntimeSandbox | null;

/**
 * The part of a run's SDK options that the sandbox touches: the SDK `sandbox` option and the permission rules inside the flag `settings`.
 * Everything else in the options is left alone.
 */
// Consumed by claude-runtime.provider.js, which passes the run's SDK options to `applyRuntimeSandboxAdditions`.
export type RuntimeSdkOptions = { sandbox?: unknown; settings?: Record<string, unknown> } & Record<string, unknown>;

let runtimeSandboxProvider: RuntimeSandboxProvider | null = null;

/**
 * Registers the provider of the sandbox of sessions that must run isolated (the Foreman bridge's). Unlike the additions provider it is never
 * skipped on a timeout: a session that has a sandbox runs in it or not at all. Pass `null` to take it away.
 */
// Consumed by the foreman module (through providers/index.ts) to run the sessions it started in their sandbox, and by the Claude runtime tests.
export function setClaudeRuntimeSandboxProvider(provider: RuntimeSandboxProvider | null): void {
  runtimeSandboxProvider = provider;
}

/**
 * The sandbox of a session, or what refuses its run. A provider that throws refuses: a session whose sandbox cannot be worked out must not
 * run unisolated. `null` means the session has no sandbox (or no provider is registered, or the run has no session id).
 */
// Consumed by claude-runtime.provider.js before every run, to decide whether the run is sandboxed, refused or plain.
export function resolveRuntimeSandbox(sessionId: string | undefined): RuntimeSandboxRefusal | RuntimeSandbox | null {
  if (!runtimeSandboxProvider || !sessionId) return null;
  try {
    return runtimeSandboxProvider(sessionId);
  } catch (error) {
    const reason = (error as { message?: unknown } | null)?.message || error;
    return { refuse: `The sandbox of this session could not be set up (${String(reason)}), so it does not run.` };
  }
}

/**
 * The denial a sandboxed run gives a call nobody approved in time: plainly a timeout, not a decision, so the worker neither retries it nor
 * mistakes it for a refusal. `timeoutMs` is the window that was in force; it is a parameter (and not read here) because the runtime's own
 * default window is an environment-time constant of the provider.
 */
// Consumed by claude-runtime.provider.js (its permission callback) and by the Claude runtime sandbox tests.
export function approvalTimeoutMessage(toolName: string, timeoutMs: number): string {
  const window = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minute(s)` : timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} second(s)` : `${timeoutMs} millisecond(s)`;
  return `Timed out waiting for the supervisor to approve this ${toolName} call: no answer within ${window}. This is a timeout, not a decision. The call was not run. Do not retry it; say in your reply that it still needs approval.`;
}

/**
 * The run's additions with its sandbox folded in: the environment is merged (the sandbox wins where both name a variable) and the sandbox's
 * denied tools join the ones no person can un-deny. Neither argument is changed.
 */
// Consumed by claude-runtime.provider.js when a session has a sandbox, and by the Claude runtime sandbox tests.
export function withSandbox(additions: RuntimeAdditions, sandbox: RuntimeSandbox): RuntimeAdditions {
  return {
    ...additions,
    sandbox: sandbox.sandbox,
    permissions: sandbox.permissions,
    approvalTimeoutMs: sandbox.approvalTimeoutMs,
    env: { ...additions.env, ...sandbox.env },
    disallowedTools: [...new Set([...(additions.disallowedTools ?? []), ...(sandbox.disallowedTools ?? [])])],
  };
}

/**
 * Folds a sandboxed run's additions into its SDK options: the SDK `sandbox` option, and the permission rules (merged by union into the flag
 * settings, never replacing what is there). Does nothing when the additions carry no sandbox. Environment and denied tools are folded by the
 * runtime itself.
 */
// Consumed by claude-runtime.provider.js before it starts a run, and by the Claude runtime sandbox tests.
export function applyRuntimeSandboxAdditions(sdkOptions: RuntimeSdkOptions, additions: RuntimeAdditions): void {
  if (!additions.sandbox) return;
  sdkOptions.sandbox = additions.sandbox;
  const current = (sdkOptions.settings?.permissions ?? {}) as Record<string, unknown>;
  const union = (a: unknown, b: unknown): unknown[] => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    permissions: {
      ...current,
      allow: union(current.allow, additions.permissions?.allow),
      deny: union(current.deny, additions.permissions?.deny),
    },
  };
}

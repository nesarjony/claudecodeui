import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanRuntimeHooks, type ClaudeRuntimeAdditions } from '@/modules/foreman/foreman-runtime-hooks.service.js';
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

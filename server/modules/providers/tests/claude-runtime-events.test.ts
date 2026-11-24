import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import {
  argValue,
  directory,
  hasFlag,
  initializeHooks,
  kinds,
  lastSpawn,
  permissionAnswers,
  readLog,
  runPrompt,
  runtime,
  settingsWith,
  useFakeClaudeRuntime,
  waitForPermissionRequest,
} from './claude-runtime-support.js';

useFakeClaudeRuntime();

test('a normal turn reports the run start, the turn result with its tool counts, and the run end', async () => {
  const outcome = await runPrompt('work');

  assert.deepEqual(kinds(outcome), ['run_started', 'turn_result', 'run_ended']);
  for (const event of outcome.events) {
    assert.equal(event.sessionId, 'app-session-1');
    assert.equal(event.projectPath, '/mnt/dev/repo');
  }

  const started = outcome.events[0] as Extract<ClaudeRuntimeEvent, { kind: 'run_started' }>;
  assert.equal(started.resumed, false);
  assert.equal(started.model, 'claude-sonnet-5-5@api');
  assert.equal(started.permissionMode, 'default');

  const turn = outcome.events[1] as Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;
  assert.equal(turn.message.type, 'result');
  assert.equal(turn.message.total_cost_usd, 0.25);
  assert.equal(turn.model, 'claude-sonnet-5-5');
  // Bash + two Reads on the main thread; the subagent's own call is not counted. One tool error.
  assert.equal(turn.toolCalls, 3);
  assert.equal(turn.toolErrors, 1);

  assert.deepEqual((outcome.events[2] as { reason: string }).reason, 'completed');
});

test('a result that belongs to an earlier queued turn does not end the turn', async () => {
  const outcome = await runPrompt('queued');
  const turns = outcome.events.filter((event) => event.kind === 'turn_result') as Array<Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>>;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].message.result, 'this turn');
});

test('a refusal is reported from the stop reason and from the structured notice', async () => {
  const outcome = await runPrompt('refuse');
  assert.deepEqual(kinds(outcome), ['run_started', 'assistant_refusal', 'system_message', 'turn_result', 'run_ended']);
  const notice = outcome.events[2] as Extract<ClaudeRuntimeEvent, { kind: 'system_message' }>;
  assert.equal(notice.message.subtype, 'model_refusal_no_fallback');
  const turn = outcome.events[3] as Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;
  assert.equal(turn.message.stop_reason, 'refusal');
});

test('a request the CLI gave up on is reported with the SDK\'s own classification, and the retry notices before it are not', async () => {
  const outcome = await runPrompt('rate-limited');
  assert.deepEqual(kinds(outcome), ['run_started', 'assistant_error', 'turn_result', 'run_ended']);
  const gaveUp = outcome.events[1] as Extract<ClaudeRuntimeEvent, { kind: 'assistant_error' }>;
  assert.equal(gaveUp.error, 'rate_limit');
  assert.equal(gaveUp.text, 'API Error: Request rejected (429)');
});

test('a manual /compact surfaces its compact boundary, and the CLI receives the command text unchanged', async () => {
  const outcome = await runPrompt('/compact keep the task notes');
  assert.deepEqual(kinds(outcome), ['run_started', 'system_message', 'turn_result', 'run_ended']);
  const boundary = outcome.events[1] as Extract<ClaudeRuntimeEvent, { kind: 'system_message' }>;
  assert.equal(boundary.message.subtype, 'compact_boundary');

  const log = await readLog();
  assert.ok(log.some((entry) => entry.prompt === '/compact keep the task notes'), 'the slash command reaches the CLI through the prompt stream');
});

test('a permission prompt is reported with the request id, tool and input, and answering it ends the turn', async () => {
  const pending = runPrompt('ask');
  // The runtime waits for an approval from a client; find the request through the reported event.
  const request = await waitForPermissionRequest('app-session-1');
  assert.equal(request.toolName, 'Bash');
  assert.deepEqual(request.input, { command: 'rm -rf build' });
  assert.equal(request.sessionId, 'app-session-1');

  runtime.resolveToolApproval(request.requestId, { allow: true });
  const outcome = await pending;
  assert.ok(kinds(outcome).includes('turn_result'));
  assert.equal(kinds(outcome).at(-1), 'run_ended');
});

test('a CLI that dies reports the run error and ends the run as failed', async () => {
  const outcome = await runPrompt('crash', {}, 'app-session-crash');
  assert.ok(kinds(outcome).includes('run_started'));
  const failure = outcome.events.find((event) => event.kind === 'run_error') as Extract<ClaudeRuntimeEvent, { kind: 'run_error' }>;
  assert.ok(failure, 'run_error published');
  assert.ok(failure.message.length > 0);
  const ended = outcome.events.at(-1) as Extract<ClaudeRuntimeEvent, { kind: 'run_ended' }>;
  assert.equal(ended.kind, 'run_ended');
  assert.equal(ended.reason, 'error');
});

test('a run started without an app session id publishes nothing', async () => {
  const outcome = await runPrompt('work', { sessionId: undefined });
  // Provider-native ids are not addressable through the app's APIs, so such runs stay unreported.
  assert.deepEqual(outcome.events, []);
});

test('a live process can be steered: context usage is read in summary form and the model can be switched', async () => {
  assert.equal(runtime.isClaudeSDKSessionActive('app-session-live'), undefined, 'not live before it starts');
  assert.equal(await runtime.setClaudeSessionModel('app-session-live', 'opus'), false);
  assert.equal(await runtime.getClaudeSessionContextUsage('app-session-live'), null);

  const pending = runPrompt('ask', {}, 'app-session-live');
  const request = await waitForPermissionRequest('app-session-live');
  assert.equal(runtime.isClaudeSDKSessionActive('app-session-live'), true);

  const usage = await runtime.getClaudeSessionContextUsage('app-session-live');
  assert.equal(usage?.totalTokens, 1234);
  assert.equal(usage?.maxTokens, 200000);
  assert.equal(await runtime.setClaudeSessionModel('app-session-live', 'claude-opus-5-5'), true);

  const log = await readLog();
  const usageRequest = log.find((entry) => entry.control === 'get_context_usage');
  assert.equal(usageRequest?.request.detail, 'summary', 'no per-category token-count calls');
  assert.equal(log.find((entry) => entry.control === 'set_model')?.request.model, 'claude-opus-5-5');

  runtime.resolveToolApproval(request.requestId, { allow: true });
  await pending;
  assert.ok(!runtime.isClaudeSDKSessionActive('app-session-live'), 'gone once the run ends');
});

test('aborting a run ends it as aborted, with no turn result and no error', async () => {
  const pending = runPrompt('ask', {}, 'app-session-abort');
  await waitForPermissionRequest('app-session-abort');

  assert.equal(await runtime.abortClaudeSDKSession('app-session-abort'), true);
  const outcome = await pending;

  const own = outcome.events.filter((event) => event.sessionId === 'app-session-abort');
  assert.deepEqual(own.map((event) => event.kind), ['run_started', 'permission_request', 'run_ended']);
  assert.equal((own.at(-1) as Extract<ClaudeRuntimeEvent, { kind: 'run_ended' }>).reason, 'aborted');
});

test('a listener that throws never disturbs the run or other listeners', async () => {
  const seen: string[] = [];
  const off = [
    runtime.subscribeClaudeRuntimeEvents(() => { throw new Error('bad listener'); }),
    runtime.subscribeClaudeRuntimeEvents((event: ClaudeRuntimeEvent) => seen.push(event.kind)),
  ];
  try {
    const outcome = await runPrompt('hello');
    assert.ok(kinds(outcome).includes('turn_result'));
    assert.ok(seen.includes('turn_result'));
  } finally {
    off.forEach((unsubscribe) => unsubscribe());
  }
});

test('the API key file is detected without exposing the key', () => {
  assert.equal(runtime.hasClaudeApiKey(), true);
});

// ---------------------------------------------------------------------------------------------
// Hooks the additions provider adds: merged into the run's own, never replacing them
// ---------------------------------------------------------------------------------------------

const noopHook = { matcher: '', hooks: [async () => ({})] };

test('a run without additions registers only its own hooks', async () => {
  await runPrompt('hello', {}, 'app-session-hooks-none');
  assert.deepEqual(Object.keys(await initializeHooks()), ['Notification']);
});

test('hooks from the additions join the run\'s own: Notification stays, PreToolUse is added', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({ hooks: { PreToolUse: [noopHook] } }));
  try {
    const outcome = await runPrompt('hello', {}, 'app-session-hooks-merge');
    assert.ok(kinds(outcome).includes('turn_result'));
    const hooks = await initializeHooks();
    assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PreToolUse']);
    assert.equal(hooks.Notification.length, 1);
    assert.equal(hooks.PreToolUse.length, 1);
    assert.equal(hooks.PreToolUse[0].matcher, '');
    assert.equal(hooks.PreToolUse[0].hookCallbackIds.length, 1);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('hooks for an event the run already hooks are appended after its own matchers', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({ hooks: { Notification: [{ matcher: 'extra', hooks: [async () => ({})] }] } }));
  try {
    await runPrompt('hello', {}, 'app-session-hooks-append');
    const hooks = await initializeHooks();
    assert.deepEqual(hooks.Notification.map((matcher) => matcher.matcher), ['', 'extra']);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('a run without a sandbox is unchanged: its prompt carries no sandbox flag, and the CLI gets no sandbox settings', async () => {
  const pending = runPrompt('ask', {}, 'app-session-no-sandbox');
  const request = await waitForPermissionRequest('app-session-no-sandbox');
  assert.equal('sandboxed' in request, false);
  runtime.resolveToolApproval(request.requestId, { allow: true });
  const outcome = await pending;
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
  const { argv } = await lastSpawn();
  assert.equal(argv.includes('--settings') && 'sandbox' in JSON.parse(argValue(argv, '--settings')), false);
});

test('a prompt of a run without a sandbox keeps the runtime\'s own approval window and its plain timeout message', async () => {
  const outcome = await runPrompt('ask', {}, 'app-session-env-timeout');
  assert.ok(kinds(outcome).includes('turn_result'), 'the run goes on after the denial');
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.equal(answer?.response.message, 'Permission request timed out');
  assert.ok(outcome.sent.some((message) => message.kind === 'permission_cancelled' && message.reason === 'timeout'));
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved'), 'a timeout settles the prompt too');
});

// ---------------------------------------------------------------------------------------------
// The refusal fallback model and denied tools, from the runtime additions provider
// ---------------------------------------------------------------------------------------------

test('the additions provider is asked with the run\'s SDK model, without the @api marker', async () => {
  const asked: Array<{ sessionId: string; projectPath: string | null; model?: string }> = [];
  runtime.setClaudeRuntimeAdditionsProvider(async (session: { sessionId: string; projectPath: string | null; model?: string }) => {
    asked.push(session);
    return {};
  });
  try {
    await runPrompt('hello', {}, 'app-session-asked-model');
    assert.deepEqual(asked, [{ sessionId: 'app-session-asked-model', projectPath: '/mnt/dev/repo', model: 'claude-sonnet-5-5' }]);
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('a fallback model and denied tools from the additions reach the CLI, next to the settings\' own disallowed tools', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({
    fallbackModel: 'claude-opus-5-5',
    disallowedTools: ['mcp__infigraph__save_session', 'Bash(rm:*)'],
    env: { CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '1' },
  }));
  try {
    const outcome = await runPrompt('hello', { toolsSettings: settingsWith({ disallowedTools: ['Bash(rm:*)', 'WebFetch'] }) }, 'app-session-fallback');
    assert.ok(kinds(outcome).includes('turn_result'));
    const { argv, catchAll } = await lastSpawn();
    assert.equal(argValue(argv, '--fallback-model'), 'claude-opus-5-5');
    assert.deepEqual(argValue(argv, '--disallowedTools').split(/[ ,]+/).sort(), ['Bash(rm:*)', 'WebFetch', 'mcp__infigraph__save_session']);
    assert.equal(catchAll, '1');
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

test('without additions the CLI gets no fallback model, and a run without the provider is unchanged', async () => {
  await runPrompt('hello', { toolsSettings: settingsWith({ disallowedTools: ['WebFetch'] }) }, 'app-session-no-fallback');
  const { argv, catchAll } = await lastSpawn();
  assert.equal(hasFlag(argv, '--fallback-model'), false);
  assert.equal(argValue(argv, '--disallowedTools'), 'WebFetch');
  assert.equal(catchAll, null);
});

test('a denied tool is refused by canUseTool at once, in a bypass mode too, with no prompt', async () => {
  runtime.setClaudeRuntimeAdditionsProvider(async () => ({ disallowedTools: ['Bash'] }));
  try {
    const plain = await runPrompt('ask', {}, 'app-session-denied-tool');
    assert.ok(!kinds(plain).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Tool disallowed by settings');

    const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-denied-tool-bypass');
    assert.ok(!kinds(bypass).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
});

// ---------------------------------------------------------------------------------------------
// canUseTool: a call the guard holds is not waved through by a stored allow rule or a bypass mode
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Billing: what the CLI child of an api-key / cap session is given
// ---------------------------------------------------------------------------------------------

const AMBIENT_ENV = {
  ANTHROPIC_AUTH_TOKEN: 'ambient-proxy-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-oauth-refresh',
  ANTHROPIC_BASE_URL: 'http://ambient.invalid',
  ANTHROPIC_CUSTOM_HEADERS: 'x-claude-cap-profile: ambient',
  ANTHROPIC_MODEL: 'ambient-non-claude-model',
  CLAUDE_CODE_SUBAGENT_MODEL: 'ambient-subagent-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
};
const KEY_FILE_SECRET = 'sk-ant-test-not-a-real-key';

async function withAmbientEnv<T>(extra: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const set = { ...AMBIENT_ENV, ...extra };
  const previous = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  Object.assign(process.env, set);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const flagSettings = (argv: string[]): { env?: Record<string, string> } => JSON.parse(argValue(argv, '--settings'));

test('a cap session gets the claude-cap profile URL, the profile header, a placeholder key and Claude model names, and no real credential', async () => {
  await withAmbientEnv({}, async () => {
    const outcome = await runPrompt('hello', { model: 'claude-sonnet-5-5@cap' }, 'app-session-cap');
    assert.ok(kinds(outcome).includes('turn_result'));
    const { argv, env } = await lastSpawn();

    // The marker is stripped; the CLI is told the plain Claude name.
    assert.equal(argValue(argv, '--model'), 'claude-sonnet-5-5');

    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:34817/profile/foreman-worker');
    assert.equal(env.ANTHROPIC_LLM_HOST, 'http://127.0.0.1:34817/profile/foreman-worker');
    assert.equal(env.ANTHROPIC_API_BASE_URL, 'http://127.0.0.1:34817/profile/foreman-worker');
    assert.equal(env.CLAUDE_AGENT_API_BASE_URL, 'http://127.0.0.1:34817/profile/foreman-worker');
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: foreman-worker');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-cap-dummy-not-used');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5');
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-haiku-4-5');

    // No credential of any kind survives from the ambient environment, and the key file's key is never read.
    for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_BEDROCK']) {
      assert.equal(name in env, false, `${name} must not reach a cap session`);
    }
    assert.equal(JSON.stringify([env, argv]).includes(KEY_FILE_SECRET), false);
    assert.equal(JSON.stringify([env, argv]).includes('ambient-'), false);

    // The user's settings.json env beats the process env (measured with the CLI), so the same values ride in the
    // flag-level settings, which outrank it, and the settings file's own token is blanked.
    const settings = flagSettings(argv);
    assert.deepEqual(settings.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
      ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
      CLAUDE_AGENT_API_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
      ANTHROPIC_LLM_HOST: 'http://127.0.0.1:34817/profile/foreman-worker',
      ANTHROPIC_API_KEY: 'sk-ant-cap-dummy-not-used',
      ANTHROPIC_CUSTOM_HEADERS: 'x-claude-cap-profile: foreman-worker',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_AUTH_TOKEN: '',
    });
  });
});

test('the claude-cap URL and the profile of a cap session can be configured, and bad values fall back to the defaults', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    await withAmbientEnv({ CLAUDE_CAP_URL: 'http://10.0.0.7:9000/', CLAUDE_CAP_PROFILE: 'night-shift' }, async () => {
      await runPrompt('hello', { model: 'sonnet@cap' }, 'app-session-cap-config');
      const { env, argv } = await lastSpawn();
      assert.equal(env.ANTHROPIC_BASE_URL, 'http://10.0.0.7:9000/profile/night-shift');
      assert.equal(env.ANTHROPIC_LLM_HOST, 'http://10.0.0.7:9000/profile/night-shift');
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: night-shift');
      assert.equal(flagSettings(argv).env?.ANTHROPIC_BASE_URL, 'http://10.0.0.7:9000/profile/night-shift');
    });
    await withAmbientEnv({ CLAUDE_CAP_URL: 'file:///etc/passwd', CLAUDE_CAP_PROFILE: 'a\r\nx-evil: 1' }, async () => {
      await runPrompt('hello', { model: 'sonnet@cap' }, 'app-session-cap-bad-config');
      const { env } = await lastSpawn();
      assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:34817/profile/foreman-worker');
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: foreman-worker');
    });
    assert.equal(warnings.filter((args) => String(args[0]).includes('CLAUDE_CAP_')).length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('a resumed cap session stays a cap session: the stored model wins over the one the caller sends', async () => {
  await withAmbientEnv({}, async () => {
    const sent: Array<Record<string, unknown>> = [];
    const writer = { userId: null, send: (message: Record<string, unknown>) => void sent.push(message), setSessionId: () => undefined };
    await runtime.queryClaudeSDK(
      'carry on',
      // The caller (a UI turn, or a bridge message) names a plain model; the session row says it is a cap session.
      { sessionId: 'app-session-cap-resume', projectPath: '/mnt/dev/repo', cwd: directory, model: 'claude-opus-5-5', permissionMode: 'default' },
      writer,
      {
        resolveProviderSessionId: () => 'prov-fake-session',
        resolveResumeModel: async () => 'claude-sonnet-5-5@cap',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      },
    );
    const { argv, env } = await lastSpawn();
    assert.ok(argv.includes('--resume=prov-fake-session'), 'the run resumes the provider session');
    assert.equal(argValue(argv, '--model'), 'claude-sonnet-5-5');
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: foreman-worker');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-cap-dummy-not-used');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  });
});

test('an api-key session is unchanged: the key file key, Anthropic URL, no profile header', async () => {
  await withAmbientEnv({}, async () => {
    await runPrompt('hello', { model: 'claude-sonnet-5-5@api' }, 'app-session-api-key');
    const { env, argv } = await lastSpawn();
    assert.equal(env.ANTHROPIC_API_KEY, KEY_FILE_SECRET);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
    assert.equal(flagSettings(argv).env?.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  });
});

test('a subscription session is left alone by the billing modes: no key override, no profile header, no settings override', async () => {
  await runPrompt('hello', { model: 'claude-sonnet-5-5' }, 'app-session-subscription');
  const { env, argv } = await lastSpawn();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(argv.includes('--settings'), false);
});


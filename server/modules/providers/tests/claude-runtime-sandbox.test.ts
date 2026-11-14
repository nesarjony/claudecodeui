import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRuntimeSandboxAdditions,
  approvalTimeoutMessage,
  withSandbox,
} from '@/modules/providers/list/claude/claude-runtime-sandbox.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import {
  argValue,
  DEFAULT_APPROVAL_WINDOW_MS,
  initializeHooks,
  kinds,
  lastSpawn,
  permissionAnswers,
  readLog,
  runPrompt,
  runtime,
  settingsWith,
  sleep,
  useFakeClaudeRuntime,
  waitForPermissionRequest,
  withSandboxProvider,
  type RunOutcome,
} from './claude-runtime-support.js';

useFakeClaudeRuntime();

/**
 * The sandbox of a Foreman session as the runtime applies it. The runtime asks its sandbox provider (registered by the Foreman bridge)
 * for each run of a session: `null` for none, `{ refuse }` when the run must not start, otherwise the additions below. The stand-in has
 * the shape `buildSandboxAdditions` produces; the real provider is exercised through the bridge module in
 * foreman-delegation-integration.test.ts.
 */
const sandboxAdditions = (overrides: Record<string, unknown> = {}) => ({
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ['registry.npmjs.org:443'], allowAllUnixSockets: false, strictAllowlist: true },
    filesystem: { denyRead: ['/home'], allowRead: ['/mnt/dev/scratch'], allowWrite: ['/mnt/dev/scratch'], denyWrite: [] as string[] },
    credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] },
  } as Record<string, unknown>,
  permissions: { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)'] },
  disallowedTools: ['AskUserQuestion', 'WebFetch'],
  env: { TMPDIR: '/mnt/dev/scratch/tmp', CLAUDE_CODE_TMPDIR: '/mnt/dev/scratch/cc' },
  approvalTimeoutMs: 400,
  ...overrides,
});

async function withAdditions<T>(provider: Parameters<typeof runtime.setClaudeRuntimeAdditionsProvider>[0], run: () => Promise<T>): Promise<T> {
  runtime.setClaudeRuntimeAdditionsProvider(provider);
  try {
    return await run();
  } finally {
    runtime.setClaudeRuntimeAdditionsProvider(null);
  }
}

type PermissionRequest = Extract<ClaudeRuntimeEvent, { kind: 'permission_request' }>;
type RunError = Extract<ClaudeRuntimeEvent, { kind: 'run_error' }>;

// ---------------------------------------------------------------------------------------------
// A run that cannot be sandboxed does not start
// ---------------------------------------------------------------------------------------------

test('a session whose sandbox cannot be applied does not run: the CLI is never started and the run says why', async () => {
  const reason = 'The stored sandbox of this session is malformed, so it does not run: a sandboxed session never runs without isolation.';
  const logged = (await readLog()).length;
  const outcome = await withSandboxProvider(() => ({ refuse: reason }), () => runPrompt('hello', {}, 'app-session-sb-refused'));

  // Not even a run_started: nothing began.
  assert.deepEqual(kinds(outcome), ['run_error']);
  assert.equal((outcome.events[0] as RunError).message, reason);
  assert.ok(outcome.sent.some((message) => message.kind === 'error' && message.content === reason), 'the chat is told');
  assert.equal((await readLog()).length, logged, 'the fake CLI noted nothing: it was not started, and the prompt never reached it');
  assert.ok(!runtime.isClaudeSDKSessionActive('app-session-sb-refused'));
});

test('a sandbox provider that throws refuses the run too', async () => {
  const logged = (await readLog()).length;
  const outcome = await withSandboxProvider(() => { throw new Error('database is locked'); }, () => runPrompt('hello', {}, 'app-session-sb-throws'));
  assert.deepEqual(kinds(outcome), ['run_error']);
  assert.match((outcome.events[0] as RunError).message, /^The sandbox of this session could not be set up \(database is locked\), so it does not run\./);
  assert.equal((await readLog()).length, logged);
});

test('the sandbox is asked for by the app session id, a session without one is not asked, and an answer of null means no sandbox', async () => {
  const asked: string[] = [];
  const outcome = await withSandboxProvider((sessionId) => { asked.push(sessionId); return null; }, async () => {
    const withSession = await runPrompt('hello', {}, 'app-session-sb-asked');
    await runPrompt('hello', { sessionId: undefined });
    return withSession;
  });
  assert.deepEqual(asked, ['app-session-sb-asked']);
  assert.ok(kinds(outcome).includes('turn_result'));
  const { argv } = await lastSpawn();
  assert.equal(argv.includes('--settings') && 'sandbox' in JSON.parse(argValue(argv, '--settings')), false, 'null adds no sandbox');
});

// ---------------------------------------------------------------------------------------------
// What a sandboxed run gets
// ---------------------------------------------------------------------------------------------

test('a sandboxed run gets the SDK sandbox, the permission rules, the merged environment and the united denied tools', async () => {
  const additions = sandboxAdditions();
  const outcome = await withAdditions(
    async () => ({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', TMPDIR: 'from-the-additions' },
      disallowedTools: ['mcp__infigraph__save_session', 'WebFetch'],
    }),
    () => withSandboxProvider(() => additions, () => runPrompt('hello', {
      model: 'claude-sonnet-5-5@cap',
      toolsSettings: settingsWith({ disallowedTools: ['Bash(rm:*)', 'WebFetch'] }),
    }, 'app-session-sb-applied')),
  );
  assert.ok(kinds(outcome).includes('turn_result'));

  const { argv, scratch } = await lastSpawn();
  const settings = JSON.parse(argValue(argv, '--settings')) as { sandbox: unknown; permissions: unknown; env: Record<string, string> };
  assert.deepEqual(settings.sandbox, additions.sandbox, 'the SDK sandbox option, with every switch as given');
  assert.deepEqual(settings.permissions, { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)'] });
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:34817/profile/foreman-worker', 'the routing the cap session already had in the settings stays beside the sandbox');

  // Denied tools: the sandbox's, the additions' and the settings' own, each once.
  assert.deepEqual(argValue(argv, '--disallowedTools').split(/[ ,]+/).sort(), ['AskUserQuestion', 'Bash(rm:*)', 'WebFetch', 'mcp__infigraph__save_session']);
  // Environment: the additions' own variables stay, and where both name one the sandbox's wins.
  assert.equal(scratch.tmpdir, '/mnt/dev/scratch/tmp');
  assert.equal(scratch.claudeTmpdir, '/mnt/dev/scratch/cc');
  assert.equal(scratch.autocompact, '70');
});

test('a prompt in a sandboxed run is reported as sandboxed, and either side can answer it', async () => {
  await withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: 20_000 }), async () => {
    const pending = runPrompt('ask', {}, 'app-session-sb-prompt');
    const request = await waitForPermissionRequest('app-session-sb-prompt');
    assert.equal(request.toolName, 'Bash');
    assert.deepEqual(request.input, { command: 'rm -rf build' });
    assert.equal(request.sandboxed, true);
    // It is listed as pending (this is what the bridge answers through), exactly like any prompt.
    assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-sb-prompt').map((entry: { requestId: string }) => entry.requestId), [request.requestId]);

    runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Pushing is not part of this task.' });
    const outcome = await pending;
    assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
    assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-sb-prompt'), []);
    assert.ok(outcome.sent.some((message) => message.kind === 'permission_request' && message.requestId === request.requestId), 'the chat UI is asked too');
    assert.ok(outcome.sent.some((message) => message.kind === 'permission_resolved' && message.requestId === request.requestId), 'and told when it was settled');
    const answer = (await permissionAnswers()).at(-1);
    assert.equal(answer?.response.behavior, 'deny');
    assert.equal(answer?.response.message, 'Pushing is not part of this task.');
    assert.ok(kinds(outcome).includes('turn_result'));
  });
});

test('an aborted sandboxed prompt is not reported as resolved: the run just ends', async () => {
  await withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: 20_000 }), async () => {
    const pending = runPrompt('ask', {}, 'app-session-sb-abort');
    await waitForPermissionRequest('app-session-sb-abort');
    assert.equal(await runtime.abortClaudeSDKSession('app-session-sb-abort'), true);
    const outcome = await pending;
    assert.deepEqual(outcome.events.filter((event) => event.sessionId === 'app-session-sb-abort').map((event) => event.kind), ['run_started', 'permission_request', 'run_ended']);
  });
});

// ---------------------------------------------------------------------------------------------
// A prompt nobody answers is a timeout
// ---------------------------------------------------------------------------------------------

test('a prompt unanswered past the sandbox\'s approvalTimeoutMs is denied as a timeout, not a decision, and a late answer finds nothing', async () => {
  const started = Date.now();
  const outcome = await withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: 300 }), () => runPrompt('ask', {}, 'app-session-sb-timeout'));
  assert.ok(Date.now() - started < DEFAULT_APPROVAL_WINDOW_MS, 'the sandbox\'s window applied, not the runtime\'s longer default');
  assert.ok(kinds(outcome).includes('turn_result'), 'the run goes on after the denial');

  const request = outcome.events.find((event) => event.kind === 'permission_request') as PermissionRequest;
  assert.equal(request.sandboxed, true);
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.match(answer?.response.message ?? '', /^Timed out waiting for the supervisor to approve this Bash call: no answer within 300 millisecond\(s\)\. This is a timeout, not a decision\. The call was not run\./);
  assert.notEqual(answer?.response.message, 'Permission request timed out', 'not the plain message of an unsandboxed run');
  assert.ok(outcome.sent.some((message) => message.kind === 'permission_cancelled' && message.requestId === request.requestId && message.reason === 'timeout'), 'the chat UI retracts the prompt');
  assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
  assert.deepEqual(runtime.getPendingApprovalsForSession('app-session-sb-timeout'), []);

  // A late answer has nothing to resolve (the bridge reports it as 404 NO_PENDING_PERMISSION) and changes nothing.
  assert.doesNotThrow(() => runtime.resolveToolApproval(request.requestId, { allow: true }));
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
});

test('a sandbox whose policy sets no window waits the runtime\'s default, and the timeout message names that window, not an assumed one', async () => {
  const outcome = await withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: undefined }), () => runPrompt('ask', {}, 'app-session-sb-default-window'));
  assert.ok(kinds(outcome).includes('turn_result'));
  const answer = (await permissionAnswers()).at(-1);
  assert.equal(answer?.response.behavior, 'deny');
  assert.match(answer?.response.message ?? '', new RegExp(`no answer within ${DEFAULT_APPROVAL_WINDOW_MS / 1000} second\\(s\\)\\. This is a timeout, not a decision`));
});

test('the timeout message states the window that was in force, in the unit that keeps it exact', () => {
  const windowOf = (ms: number) => /no answer within (.+?)\. This is/.exec(approvalTimeoutMessage('Bash', ms))?.[1];
  assert.equal(windowOf(1_800_000), '30 minute(s)');
  assert.equal(windowOf(120_000), '2 minute(s)');
  assert.equal(windowOf(55_000), '55 second(s)');
  assert.equal(windowOf(300), '300 millisecond(s)');
});

test('a sandbox window longer than the runtime\'s own keeps the prompt pending past it, and a later answer is honoured', async () => {
  await withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: 20_000 }), async () => {
    const pending = runPrompt('ask', {}, 'app-session-sb-long-wait');
    const request = await waitForPermissionRequest('app-session-sb-long-wait');
    await sleep(DEFAULT_APPROVAL_WINDOW_MS + 700);
    assert.deepEqual(
      runtime.getPendingApprovalsForSession('app-session-sb-long-wait').map((entry: { requestId: string }) => entry.requestId),
      [request.requestId],
      'the runtime\'s own window has passed and the sandboxed prompt is still waiting',
    );
    runtime.resolveToolApproval(request.requestId, { allow: true });
    const outcome = await pending;
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'allow');
    assert.ok(kinds(outcome).includes('turn_result'));
  });
});

// ---------------------------------------------------------------------------------------------
// Tools only a person can answer (AskUserQuestion, ExitPlanMode): a sandboxed run has nobody to ask
// ---------------------------------------------------------------------------------------------

const INTERACTIVE_TOOLS = [
  { prompt: 'askq', toolName: 'AskUserQuestion' },
  { prompt: 'askplan', toolName: 'ExitPlanMode' },
] as const;

// Without the refusal such a run waits for a person for ever (these prompts have no timeout): give up on it and end the run
// instead of hanging the whole suite.
async function settlesWithin(pending: Promise<RunOutcome>, sessionId: string, ms = 5000): Promise<RunOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void runtime.abortClaudeSDKSession(sessionId);
      reject(new Error(`${sessionId} was still waiting for a person after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([pending, giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

function assertNobodyWasAsked(outcome: RunOutcome, sessionId: string): void {
  assert.ok(!kinds(outcome).includes('permission_request'), 'no permission_request event');
  assert.ok(!kinds(outcome).includes('permission_resolved'), 'nothing to resolve');
  assert.ok(!outcome.sent.some((message) => message.kind === 'permission_request' || message.kind === 'permission_cancelled'), 'the chat UI is not asked either');
  assert.deepEqual(runtime.getPendingApprovalsForSession(sessionId), [], 'nothing is pending');
  assert.ok(kinds(outcome).includes('turn_result'), 'the turn ran to its end');
}

for (const { prompt, toolName } of INTERACTIVE_TOOLS) {
  test(`a sandboxed run's ${toolName} is denied at once: no prompt, no event, no waiting`, async () => {
    const sessionId = `app-session-sb-unattended-${prompt}`;
    const before = (await permissionAnswers()).length;
    const outcome = await withSandboxProvider(() => sandboxAdditions(), () => settlesWithin(runPrompt(prompt, {}, sessionId), sessionId));
    assertNobodyWasAsked(outcome, sessionId);
    const answers = await permissionAnswers();
    assert.equal(answers.length, before + 1);
    assert.equal(answers.at(-1)?.response.behavior, 'deny');
    assert.match(answers.at(-1)?.response.message ?? '', /^No person is available to answer this tool call in this session, because it runs unattended\./);
  });

  test(`a sandboxed run's ${toolName} is denied even when settings would allow it or skip permissions`, async () => {
    const sessionId = `app-session-sb-unattended-settings-${prompt}`;
    const toolsSettings = settingsWith({ skipPermissions: true, allowedTools: ['AskUserQuestion', 'ExitPlanMode'] });
    const outcome = await withSandboxProvider(() => sandboxAdditions({ disallowedTools: [] }), () => settlesWithin(runPrompt(prompt, { toolsSettings }, sessionId), sessionId));
    assertNobodyWasAsked(outcome, sessionId);
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  });

  test(`a run without a sandbox still prompts a person for ${toolName} and waits for the answer, with no timeout`, async () => {
    const sessionId = `app-session-interactive-${prompt}`;
    const pending = runPrompt(prompt, {}, sessionId);
    const request = await waitForPermissionRequest(sessionId);
    assert.equal(request.toolName, toolName);
    assert.equal('sandboxed' in request, false);
    assert.deepEqual(runtime.getPendingApprovalsForSession(sessionId).map((entry: { requestId: string }) => entry.requestId), [request.requestId]);

    if (toolName === 'AskUserQuestion') {
      // The approval window the other prompts have does not apply to these: still waiting after it.
      await sleep(DEFAULT_APPROVAL_WINDOW_MS + 700);
      assert.equal(runtime.getPendingApprovalsForSession(sessionId).length, 1);
    }

    runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not now.' });
    const outcome = await settlesWithin(pending, sessionId);
    assert.ok(outcome.events.some((event) => event.kind === 'permission_resolved' && event.requestId === request.requestId));
    const answer = (await permissionAnswers()).at(-1);
    assert.equal(answer?.response.behavior, 'deny');
    assert.equal(answer?.response.message, 'Not now.');
  });
}

// ---------------------------------------------------------------------------------------------
// canUseTool in a sandboxed run: the sandbox bounds what a call can do, the denied tools stay denied
// ---------------------------------------------------------------------------------------------

// A bypass mode does not: see claude-runtime-sandbox-modes.test.ts.
test('in a sandboxed run a stored allow rule settles a call without a prompt, as in any run', async () => {
  await withSandboxProvider(() => sandboxAdditions({ disallowedTools: [] }), async () => {
    const before = (await permissionAnswers()).length;
    const rule = await runPrompt('ask', { toolsSettings: settingsWith({ allowedTools: ['Bash'] }) }, 'app-session-sb-rule');
    assert.ok(!kinds(rule).includes('permission_request'));
    const answers = await permissionAnswers();
    assert.equal(answers.length, before + 1);
    assert.equal(answers.at(-1)?.response.behavior, 'allow');
  });
});

test('a tool the sandbox denies is refused at once with no prompt, in a bypass mode and next to a stored allow rule too', async () => {
  await withSandboxProvider(() => sandboxAdditions({ disallowedTools: ['Bash'] }), async () => {
    const plain = await runPrompt('ask', {}, 'app-session-sb-denied');
    assert.ok(!kinds(plain).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Tool disallowed by settings');

    const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-sb-denied-bypass');
    assert.ok(!kinds(bypass).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');

    // A person's earlier "always allow" for the tool does not lift the denial.
    const remembered = await runPrompt('ask', { toolsSettings: settingsWith({ allowedTools: ['Bash'] }) }, 'app-session-sb-denied-allowed');
    assert.ok(!kinds(remembered).includes('permission_request'));
    assert.equal((await permissionAnswers()).at(-1)?.response.message, 'Tool disallowed by settings');
  });
});

// ---------------------------------------------------------------------------------------------
// Beside Foreman's compaction hooks (the runtime additions provider)
// ---------------------------------------------------------------------------------------------

const FOREMAN_REPO = '/mnt/dev/repo'; // the project path runPrompt gives a run by default
const noopHook = { matcher: '', hooks: [async () => ({})] };
const foremanAdditions = async (session: { sessionId: string; projectPath: string | null }) =>
  session.projectPath === FOREMAN_REPO ? { hooks: { PreCompact: [noopHook], SessionStart: [noopHook] } } : {};

test('a sandboxed Foreman session registers the compaction hooks and the sandbox together, and the sandbox is not a hook', async () => {
  await withAdditions(foremanAdditions, () => withSandboxProvider(() => sandboxAdditions({ approvalTimeoutMs: 20_000 }), async () => {
    const pending = runPrompt('ask', {}, 'app-session-sb-both');
    // canUseTool is wired: the call is held, flagged as sandboxed.
    const request = await waitForPermissionRequest('app-session-sb-both');
    assert.equal(request.sandboxed, true);

    const registered = await initializeHooks();
    assert.deepEqual(Object.keys(registered).sort(), ['Notification', 'PreCompact', 'SessionStart']);
    for (const event of Object.keys(registered)) {
      assert.equal(registered[event].length, 1, `${event} keeps exactly one matcher`);
      assert.equal(registered[event][0].hookCallbackIds.length, 1, `${event} keeps exactly one callback`);
    }
    const { argv } = await lastSpawn();
    assert.ok('sandbox' in JSON.parse(argValue(argv, '--settings')), 'and the sandbox is in the CLI\'s settings');

    runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not in this task.' });
    const outcome = await pending;
    assert.ok(kinds(outcome).includes('turn_result'));
    assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'deny');
  }));
});

test('either half alone: a sandbox outside a Foreman repo adds no hook, a Foreman repo without a sandbox only the compaction hooks', async () => {
  await withAdditions(foremanAdditions, async () => {
    await withSandboxProvider(() => sandboxAdditions(), () => runPrompt('hello', { projectPath: '/mnt/dev/elsewhere' }, 'app-session-sb-only'));
    assert.deepEqual(Object.keys(await initializeHooks()), ['Notification']);
    const sandboxed = await lastSpawn();
    assert.ok('sandbox' in JSON.parse(argValue(sandboxed.argv, '--settings')));

    await runPrompt('hello', {}, 'app-session-compaction-only');
    assert.deepEqual(Object.keys(await initializeHooks()).sort(), ['Notification', 'PreCompact', 'SessionStart']);
    const plain = await lastSpawn();
    assert.equal(plain.argv.includes('--settings') && 'sandbox' in JSON.parse(argValue(plain.argv, '--settings')), false);
  });
});

// ---------------------------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------------------------

test('withSandbox folds a sandbox into a run\'s additions: its sandbox and rules replace none of the others, the environment merges, the denied tools unite', () => {
  const hook = { matcher: 'Bash', hooks: [async () => ({})] };
  const additions = {
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', TMPDIR: 'from-the-additions' },
    disallowedTools: ['mcp__infigraph__save_session', 'WebFetch'],
    hooks: { PreToolUse: [hook] },
    fallbackModel: 'claude-opus-5-5',
  };
  const sandbox = sandboxAdditions({ approvalTimeoutMs: 90_000 });
  const before = structuredClone({ additions: { ...additions, hooks: undefined }, sandbox });

  const folded = withSandbox(additions, sandbox);
  assert.equal(folded.sandbox, sandbox.sandbox);
  assert.deepEqual(folded.permissions, sandbox.permissions);
  assert.equal(folded.approvalTimeoutMs, 90_000);
  assert.deepEqual(folded.env, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', TMPDIR: '/mnt/dev/scratch/tmp', CLAUDE_CODE_TMPDIR: '/mnt/dev/scratch/cc' }, 'the sandbox wins where both name a variable');
  assert.deepEqual(folded.disallowedTools, ['mcp__infigraph__save_session', 'WebFetch', 'AskUserQuestion'], 'united, each once, the additions\' first');
  // What the additions already carried is kept.
  assert.equal(folded.hooks?.PreToolUse?.[0], hook);
  assert.equal(folded.fallbackModel, 'claude-opus-5-5');
  // Nothing it was given is changed.
  assert.deepEqual({ additions: { ...additions, hooks: undefined }, sandbox }, before);
});

test('withSandbox copes with additions that have no environment or denied tools, and a sandbox that has none', () => {
  const sandbox = sandboxAdditions({ env: undefined, disallowedTools: undefined });
  const folded = withSandbox({}, sandbox as never);
  assert.deepEqual(folded.env, {});
  assert.deepEqual(folded.disallowedTools, []);
  assert.equal(folded.sandbox, sandbox.sandbox);

  const onlySandbox = withSandbox({ disallowedTools: ['Bash(rm:*)'] }, sandboxAdditions());
  assert.deepEqual(onlySandbox.disallowedTools, ['Bash(rm:*)', 'AskUserQuestion', 'WebFetch']);
});

test('applyRuntimeSandboxAdditions sets the SDK sandbox and unites the permission rules with the ones already in the settings', () => {
  const allow = ['Read'];
  const deny = ['Bash(curl:*)', 'Read(~/.ssh/**)'];
  const sdkOptions: Record<string, any> = {
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:34817' }, permissions: { allow, deny, defaultMode: 'plan' } },
    env: { X: '1' },
    disallowedTools: ['WebFetch'],
  };
  const additions = sandboxAdditions();
  applyRuntimeSandboxAdditions(sdkOptions, additions);

  assert.equal(sdkOptions.sandbox, additions.sandbox);
  assert.deepEqual(sdkOptions.settings.permissions, {
    allow: ['Read', 'Bash', 'Edit(//mnt/dev/repo/**)'],
    deny: ['Bash(curl:*)', 'Read(~/.ssh/**)'],
    defaultMode: 'plan',
  });
  assert.deepEqual(sdkOptions.settings.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:34817' }, 'the rest of the settings stays');
  // Environment and denied tools are folded by the callers, not here; the arrays that were there are not edited in place.
  assert.deepEqual(sdkOptions.env, { X: '1' });
  assert.deepEqual(sdkOptions.disallowedTools, ['WebFetch']);
  assert.deepEqual(allow, ['Read']);
  assert.deepEqual(deny, ['Bash(curl:*)', 'Read(~/.ssh/**)']);
});

test('applyRuntimeSandboxAdditions makes the settings when there are none, treats rules of the wrong type as empty, and does nothing without a sandbox', () => {
  const fresh: Record<string, any> = {};
  applyRuntimeSandboxAdditions(fresh, sandboxAdditions());
  assert.deepEqual(fresh.settings, { permissions: { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)'] } });

  const odd: Record<string, any> = { settings: { permissions: { allow: 'Read', deny: null } } };
  applyRuntimeSandboxAdditions(odd, sandboxAdditions());
  assert.deepEqual(odd.settings.permissions, { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)'] });

  const withoutRules: Record<string, any> = { settings: { permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } } };
  applyRuntimeSandboxAdditions(withoutRules, { sandbox: { enabled: true } });
  assert.deepEqual(withoutRules.settings.permissions, { allow: ['Read'], deny: ['Bash(rm:*)'] });
  assert.deepEqual(withoutRules.sandbox, { enabled: true });

  for (const additions of [{}, { permissions: { allow: ['Bash'], deny: [] } }, { env: { A: '1' } }]) {
    const untouched: Record<string, any> = {};
    applyRuntimeSandboxAdditions(untouched, additions);
    assert.deepEqual(untouched, {}, 'no sandbox, nothing changed');
  }
});

test('a tool the sandbox denies stays denied when a person ticks "always allow": removeRememberedDenial only lifts the denials nobody enforced', () => {
  const options: { disallowedTools: string[] } = { disallowedTools: ['Bash(rm:*)'] };
  const folded = withSandbox({ disallowedTools: ['mcp__infigraph__save_session'] }, sandboxAdditions());
  const enforced = runtime.applyRuntimeModelAndToolAdditions(options, folded);
  assert.deepEqual(enforced, ['mcp__infigraph__save_session', 'AskUserQuestion', 'WebFetch']);
  assert.deepEqual(options.disallowedTools, ['Bash(rm:*)', 'mcp__infigraph__save_session', 'AskUserQuestion', 'WebFetch']);

  for (const entry of enforced) {
    assert.deepEqual(runtime.removeRememberedDenial(options.disallowedTools, entry, enforced), options.disallowedTools, `${entry} stays denied`);
  }
  // A denial that came from the settings is the person's to lift.
  assert.deepEqual(runtime.removeRememberedDenial(options.disallowedTools, 'Bash(rm:*)', enforced), ['mcp__infigraph__save_session', 'AskUserQuestion', 'WebFetch']);
  assert.deepEqual(runtime.removeRememberedDenial(['WebFetch'], 'WebFetch', []), []);
});

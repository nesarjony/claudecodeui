import assert from 'node:assert/strict';
import test from 'node:test';

import { confineSandboxedPermissions } from '@/modules/providers/list/claude/claude-runtime-sandbox.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import {
  argValue,
  hasFlag,
  kinds,
  lastSpawn,
  permissionAnswers,
  readLog,
  runPrompt,
  runtime,
  settingsWith,
  useFakeClaudeRuntime,
  waitForPermissionRequest,
  withSandboxProvider,
} from './claude-runtime-support.js';

useFakeClaudeRuntime();

/**
 * A sandboxed run keeps its permission prompts: the sandbox covers Bash only, and the file tools rely on the prompts that a bypass or auto
 * mode would skip. And a run marked as requiring a sandbox never goes ahead without one.
 */
const sandboxAdditions = () => ({
  sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  permissions: { allow: ['Bash'], deny: [] },
  disallowedTools: [],
  env: {},
  approvalTimeoutMs: 20_000,
});

type RunError = Extract<ClaudeRuntimeEvent, { kind: 'run_error' }>;
type RunStarted = Extract<ClaudeRuntimeEvent, { kind: 'run_started' }>;

test('run_started reports the mode the CLI really starts in: none sent is default, the UI\'s skipPermissions is a bypass, a sandbox confines it', async () => {
  const runs: Array<[string, Record<string, unknown>, string, boolean]> = [
    ['none', { permissionMode: undefined }, 'default', false],
    ['accept', { permissionMode: 'acceptEdits' }, 'acceptEdits', false],
    ['skip', { permissionMode: 'default', toolsSettings: settingsWith({ skipPermissions: true }) }, 'bypassPermissions', false],
    ['skip-plan', { permissionMode: 'plan', toolsSettings: settingsWith({ skipPermissions: true }) }, 'plan', false],
    ['sandboxed', { permissionMode: 'bypassPermissions' }, 'default', true],
  ];
  for (const [label, overrides, expected, sandboxed] of runs) {
    const run = () => runPrompt('hello', overrides, `app-session-effective-${label}`);
    const outcome = sandboxed ? await withSandboxProvider(() => sandboxAdditions(), run) : await run();
    assert.equal((outcome.events.find((event) => event.kind === 'run_started') as RunStarted).permissionMode, expected, label);
    const { argv } = await lastSpawn();
    assert.equal(hasFlag(argv, '--permission-mode') ? argValue(argv, '--permission-mode') : 'default', expected, `${label}: the mode the CLI was given`);
  }
});

test('run_started reports the tool lists the run\'s options carried', async () => {
  const owner = await runPrompt('hello', { toolsSettings: settingsWith({ allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'] }) }, 'app-session-tools-owner');
  const ownRun = owner.events.find((event) => event.kind === 'run_started') as RunStarted;
  assert.deepEqual([ownRun.allowedTools, ownRun.disallowedTools], [['Read', 'Bash(npm test:*)'], ['WebFetch']]);

  const bare = await runPrompt('hello', {}, 'app-session-tools-bare');
  const bareRun = bare.events.find((event) => event.kind === 'run_started') as RunStarted;
  assert.deepEqual([bareRun.allowedTools, bareRun.disallowedTools], [[], []]);
});

test('a sandboxed run asked for bypassPermissions, auto or the UI\'s skipPermissions still prompts, and a call is never allowed unanswered', async () => {
  const asks = [
    ['bypass', { permissionMode: 'bypassPermissions' }],
    ['auto', { permissionMode: 'auto' }],
    ['skip', { permissionMode: 'default', toolsSettings: settingsWith({ skipPermissions: true }) }],
    ['skip-auto', { permissionMode: 'auto', toolsSettings: settingsWith({ skipPermissions: true }) }],
  ] as const;
  for (const [label, overrides] of asks) {
    const sessionId = `app-session-mode-${label}`;
    await withSandboxProvider(() => sandboxAdditions(), async () => {
      const pending = runPrompt('ask', overrides, sessionId);
      const request = await waitForPermissionRequest(sessionId);
      assert.equal(request.sandboxed, true, label);
      const { argv } = await lastSpawn();
      assert.equal(hasFlag(argv, '--permission-mode'), false, `${label}: the CLI runs in the default mode`);
      assert.equal(argv.includes('--allow-dangerously-skip-permissions'), false, label);

      runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not part of the task.' });
      await pending;
      const answer = (await permissionAnswers()).at(-1);
      assert.equal(answer?.response.behavior, 'deny', label);
      assert.equal(answer?.response.message, 'Not part of the task.', label);
    });
  }
});

test('a sandboxed run keeps acceptEdits and plan, and neither plan mode nor the UI allows it a tool outright', async () => {
  for (const permissionMode of ['acceptEdits', 'plan']) {
    await withSandboxProvider(() => sandboxAdditions(), () => runPrompt('hello', {
      permissionMode,
      toolsSettings: settingsWith({ allowedTools: ['Bash(npm test:*)'] }),
    }, `app-session-mode-${permissionMode}`));
    const { argv } = await lastSpawn();
    assert.equal(argValue(argv, '--permission-mode'), permissionMode);
    assert.equal(hasFlag(argv, '--allowedTools'), false, permissionMode);
  }
});

test('a person typing into a worker\'s session runs sandboxed: the UI\'s allowed tools still prompt, its denied tools are denied', async () => {
  // A turn from the UI: no bridge mark, the person's tool settings, and the session's stored sandbox from the provider.
  const asked: boolean[] = [];
  const typed = { toolsSettings: settingsWith({ allowedTools: ['Write', 'WebFetch'], disallowedTools: ['NotebookEdit'] }) };
  await withSandboxProvider((_sessionId, run) => { asked.push(run.required); return sandboxAdditions(); }, async () => {
    for (const tool of ['Write', 'WebFetch']) {
      const sessionId = `app-session-takeover-${tool}`;
      const pending = runPrompt(`ask-tool:${tool}`, typed, sessionId);
      const request = await waitForPermissionRequest(sessionId);
      assert.deepEqual([request.toolName, request.sandboxed], [tool, true], `${tool} waits for an answer instead of being allowed`);
      const { argv } = await lastSpawn();
      assert.equal(hasFlag(argv, '--allowedTools'), false, 'the CLI is not told to allow it either');
      assert.ok(argValue(argv, '--disallowedTools').split(/[ ,]+/).includes('NotebookEdit'));
      runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not now.' });
      await pending;
    }

    const denied = await runPrompt('ask-tool:NotebookEdit', typed, 'app-session-takeover-denied');
    assert.ok(!kinds(denied).includes('permission_request'), 'a denied tool is not even asked about');
    const answer = (await permissionAnswers()).at(-1);
    assert.deepEqual([answer?.response.behavior, answer?.response.message], ['deny', 'Tool disallowed by settings']);
  });
  assert.deepEqual(asked, [false, false, false], 'the sandbox is asked for on every unmarked run');
});

test('a person\'s own session is unchanged: skipPermissions still settles a call without a prompt, and plan mode still allows its reads', async () => {
  const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-mode-owner');
  assert.ok(!kinds(bypass).includes('permission_request'));
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'allow');

  await runPrompt('hello', { permissionMode: 'plan' }, 'app-session-mode-owner-plan');
  assert.ok(argValue((await lastSpawn()).argv, '--allowedTools').split(',').includes('Read'));
});

test('confineSandboxedPermissions keeps a mode a sandboxed run may use, puts any other back to default and allows no tool outright', () => {
  const options: Record<string, unknown> = { permissionMode: 'bypassPermissions', allowedTools: ['Read', 'WebFetch', 'Bash'], disallowedTools: ['Grep'] };
  confineSandboxedPermissions(options, { permissionMode: 'auto' });
  assert.deepEqual(options, { allowedTools: [], disallowedTools: ['Grep'] });
  confineSandboxedPermissions(options, { permissionMode: 'plan' });
  assert.deepEqual(options, { permissionMode: 'plan', allowedTools: [], disallowedTools: ['Grep'] });
  confineSandboxedPermissions(options, { permissionMode: undefined });
  assert.deepEqual(options, { allowedTools: [], disallowedTools: ['Grep'] });
});

test('a run marked as the bridge\'s is refused with nobody to ask for its sandbox, and the provider is told which runs are marked', async () => {
  const logged = (await readLog()).length;
  const refused = await runPrompt('hello', { requireSandbox: true }, 'app-session-marked-alone');
  assert.deepEqual(kinds(refused), ['run_error']);
  assert.match((refused.events[0] as RunError).message, /must be sandboxed/);
  assert.equal((await readLog()).length, logged, 'the CLI was not started');

  const asked: Array<[string, boolean]> = [];
  await withSandboxProvider((sessionId, run) => { asked.push([sessionId, run.required]); return null; }, async () => {
    await runPrompt('hello', { requireSandbox: true }, 'app-session-marked');
    await runPrompt('hello', {}, 'app-session-unmarked');
  });
  assert.deepEqual(asked, [['app-session-marked', true], ['app-session-unmarked', false]]);
});

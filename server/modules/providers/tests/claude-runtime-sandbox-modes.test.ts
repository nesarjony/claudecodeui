import assert from 'node:assert/strict';
import test from 'node:test';

import { confineSandboxedPermissions } from '@/modules/providers/list/claude/claude-runtime-sandbox.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import {
  argValue,
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
 * mode would skip. And a run the Foreman bridge marked as its own never goes ahead without its sandbox.
 */
const sandboxAdditions = () => ({
  sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  permissions: { allow: ['Bash'], deny: [] },
  disallowedTools: [],
  env: {},
  approvalTimeoutMs: 20_000,
});

type RunError = Extract<ClaudeRuntimeEvent, { kind: 'run_error' }>;

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
      assert.equal(argv.includes('--permission-mode'), false, `${label}: the CLI runs in the default mode`);
      assert.equal(argv.includes('--allow-dangerously-skip-permissions'), false, label);

      runtime.resolveToolApproval(request.requestId, { allow: false, message: 'Not part of the task.' });
      await pending;
      const answer = (await permissionAnswers()).at(-1);
      assert.equal(answer?.response.behavior, 'deny', label);
      assert.equal(answer?.response.message, 'Not part of the task.', label);
    });
  }
});

test('a sandboxed run keeps acceptEdits and plan, and plan mode allows it no reads or web tools beyond the UI\'s own', async () => {
  for (const permissionMode of ['acceptEdits', 'plan']) {
    await withSandboxProvider(() => sandboxAdditions(), () => runPrompt('hello', {
      permissionMode,
      toolsSettings: settingsWith({ allowedTools: ['Bash(npm test:*)'] }),
    }, `app-session-mode-${permissionMode}`));
    const { argv } = await lastSpawn();
    assert.equal(argValue(argv, '--permission-mode'), permissionMode);
    assert.deepEqual(argValue(argv, '--allowedTools').split(','), ['Bash(npm test:*)'], permissionMode);
  }
});

test('a person\'s own session is unchanged: skipPermissions still settles a call without a prompt, and plan mode still allows its reads', async () => {
  const bypass = await runPrompt('ask', { toolsSettings: settingsWith({ skipPermissions: true }) }, 'app-session-mode-owner');
  assert.ok(!kinds(bypass).includes('permission_request'));
  assert.equal((await permissionAnswers()).at(-1)?.response.behavior, 'allow');

  await runPrompt('hello', { permissionMode: 'plan' }, 'app-session-mode-owner-plan');
  assert.ok(argValue((await lastSpawn()).argv, '--allowedTools').split(',').includes('Read'));
});

test('confineSandboxedPermissions keeps a mode a sandboxed run may use, puts any other back to default and drops what plan mode added', () => {
  const options: Record<string, unknown> = { permissionMode: 'bypassPermissions', allowedTools: ['Read', 'WebFetch', 'Bash'] };
  confineSandboxedPermissions(options, { permissionMode: 'auto', allowedTools: ['Bash', 7] });
  assert.deepEqual(options, { allowedTools: ['Bash'] });
  confineSandboxedPermissions(options, { permissionMode: 'plan' });
  assert.deepEqual(options, { permissionMode: 'plan', allowedTools: [] });
  confineSandboxedPermissions(options, { permissionMode: undefined, allowedTools: 'Read' });
  assert.deepEqual(options, { allowedTools: [] });
});

test('a run marked as the bridge\'s is refused with nobody to ask for its sandbox, and the provider is told which runs are marked', async () => {
  const logged = (await readLog()).length;
  const refused = await runPrompt('hello', { foremanSandbox: true }, 'app-session-marked-alone');
  assert.deepEqual(kinds(refused), ['run_error']);
  assert.match((refused.events[0] as RunError).message, /must be sandboxed/);
  assert.equal((await readLog()).length, logged, 'the CLI was not started');

  const asked: Array<[string, boolean]> = [];
  await withSandboxProvider((sessionId, run) => { asked.push([sessionId, run.required]); return null; }, async () => {
    await runPrompt('hello', { foremanSandbox: true }, 'app-session-marked');
    await runPrompt('hello', {}, 'app-session-unmarked');
  });
  assert.deepEqual(asked, [['app-session-marked', true], ['app-session-unmarked', false]]);
});

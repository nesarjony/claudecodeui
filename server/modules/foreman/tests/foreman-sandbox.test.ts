import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSandboxAdditions, DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS, parseSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import { AppError } from '@/shared/utils.js';

import { samplePolicy } from './foreman-sandbox-support.js';

const refuses = (value: unknown, code: string, message?: RegExp) =>
  assert.throws(() => parseSandboxPolicy(value), (error: unknown) => error instanceof AppError && error.code === code && error.statusCode === 400 && (!message || message.test(error.message)));

test('a well formed policy is read back unchanged', () => {
  assert.deepEqual(parseSandboxPolicy(JSON.parse(JSON.stringify(samplePolicy()))), samplePolicy());
});

test('a session start without a sandbox, or with a null one, does not start: the sandbox is required', () => {
  refuses(undefined, 'SANDBOX_REQUIRED');
  refuses(null, 'SANDBOX_REQUIRED');
});

test('a malformed policy is refused whatever is wrong with it', () => {
  const good = JSON.parse(JSON.stringify(samplePolicy())) as Record<string, any>;
  const without = (key: string) => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
  refuses('on', 'SANDBOX_INVALID', /object/);
  refuses([], 'SANDBOX_INVALID');
  for (const missing of ['scratchDir', 'network', 'filesystem', 'credentials', 'permissions', 'disallowedTools', 'env']) {
    refuses(without(missing), 'SANDBOX_INVALID');
  }
  refuses({ ...good, scratchDir: 'relative/path' }, 'SANDBOX_INVALID', /scratchDir/);
  refuses({ ...good, scratchDir: '/' }, 'SANDBOX_INVALID', /scratchDir/);
  refuses({ ...good, scratchDir: `/mnt/dev/${'x'.repeat(60)}` }, 'SANDBOX_INVALID', /at most 64.*unix socket/);
  refuses({ ...good, filesystem: { ...good.filesystem, denyRead: 'all' } }, 'SANDBOX_INVALID', /denyRead/);
  refuses({ ...good, filesystem: { ...good.filesystem, allowWrite: [42] } }, 'SANDBOX_INVALID', /allowWrite/);
  refuses({ ...good, permissions: { allow: ['Bash'] } }, 'SANDBOX_INVALID', /permissions\.deny/);
  refuses({ ...good, credentials: { envVars: [{ name: 'bad name', mode: 'deny' }] } }, 'SANDBOX_INVALID', /envVars/);
  refuses({ ...good, credentials: { envVars: [{ name: 'KEY', mode: 'allow' }] } }, 'SANDBOX_INVALID', /envVars/);
  refuses({ ...good, env: { TMPDIR: 3 } }, 'SANDBOX_INVALID', /env/);
  refuses({ ...good, approvalTimeoutMs: 5 }, 'SANDBOX_INVALID', /approvalTimeoutMs/);
  refuses({ ...good, disallowedTools: Array.from({ length: 401 }, (_, index) => `tool-${index}`) }, 'SANDBOX_INVALID', /disallowedTools/);
});

test('the run gets the policy with the switches that make it a sandbox forced on, whatever the policy says', () => {
  const made: string[] = [];
  const hostile = parseSandboxPolicy({ ...samplePolicy(), enabled: false, failIfUnavailable: false, allowUnsandboxedCommands: true, network: { allowedDomains: [], allowAllUnixSockets: false, strictAllowlist: false } });
  const additions = buildSandboxAdditions(hostile, (directory) => made.push(directory));
  assert.deepEqual(additions.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], allowAllUnixSockets: false, strictAllowlist: true },
    filesystem: hostile.filesystem,
    credentials: hostile.credentials,
  });
  assert.deepEqual(additions.permissions, hostile.permissions);
  assert.deepEqual(additions.disallowedTools, ['AskUserQuestion', 'WebFetch', 'ExitPlanMode']);
  assert.deepEqual(additions.env, hostile.env);
  assert.deepEqual(made, ['/mnt/dev/scratch/batch-1', '/mnt/dev/scratch/batch-1/tmp', '/mnt/dev/scratch/batch-1/cc']);
});

test('a prompt that nobody answers waits for the policy\'s window, or thirty minutes without one', () => {
  assert.equal(buildSandboxAdditions(samplePolicy(), () => undefined).approvalTimeoutMs, 120_000);
  assert.equal(buildSandboxAdditions(samplePolicy({ approvalTimeoutMs: null }), () => undefined).approvalTimeoutMs, DEFAULT_SANDBOX_APPROVAL_TIMEOUT_MS);
});

test('AskUserQuestion and ExitPlanMode are always denied, joined to whatever the policy denies', () => {
  for (const disallowedTools of [[], ['WebSearch'], ['ExitPlanMode', 'AskUserQuestion', 'WebFetch']]) {
    const denied = buildSandboxAdditions(samplePolicy({ disallowedTools }), () => undefined).disallowedTools;
    assert.deepEqual([...denied].sort(), [...new Set([...disallowedTools, 'AskUserQuestion', 'ExitPlanMode'])].sort());
  }
});

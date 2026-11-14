import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAP_DEFAULT_PROFILE,
  CAP_DEFAULT_URL,
  CAP_DUMMY_API_KEY,
  CAP_MODEL_ENV,
  CAP_PROFILE_HEADER,
  CAP_SCRUBBED_ENV,
  applyCapBilling,
  capSessionEnv,
  resolveCapConfig,
} from '@/modules/providers/list/claude/claude-cap-billing.js';

const quiet = () => undefined;

test('the defaults are the local claude-cap proxy and the foreman-worker profile', () => {
  assert.deepEqual(resolveCapConfig({}, quiet), { url: 'http://127.0.0.1:34817', profile: 'foreman-worker' });
  assert.equal(CAP_DEFAULT_URL, 'http://127.0.0.1:34817');
  assert.equal(CAP_DEFAULT_PROFILE, 'foreman-worker');
  assert.equal(CAP_PROFILE_HEADER, 'x-claude-cap-profile');
});

test('CLAUDE_CAP_URL and CLAUDE_CAP_PROFILE override the defaults; a trailing slash on the URL is dropped', () => {
  assert.deepEqual(
    resolveCapConfig({ CLAUDE_CAP_URL: 'https://cap.example.com:8443/base/', CLAUDE_CAP_PROFILE: 'worker.2_x-y' }, quiet),
    { url: 'https://cap.example.com:8443/base', profile: 'worker.2_x-y' },
  );
  assert.deepEqual(
    resolveCapConfig({ CLAUDE_CAP_URL: '  http://127.0.0.1:1234  ', CLAUDE_CAP_PROFILE: '  ' }, quiet),
    { url: 'http://127.0.0.1:1234', profile: 'foreman-worker' },
  );
});

test('a value that is not a URL / a header-safe profile name is reported and replaced by the default', () => {
  const warnings: string[] = [];
  for (const url of ['not a url', 'ftp://cap.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(resolveCapConfig({ CLAUDE_CAP_URL: url }, (message) => warnings.push(message)).url, CAP_DEFAULT_URL, url);
  }
  for (const profile of ['has space', 'a\r\nx-evil: 1', 'semi;colon', '-leading', 'x'.repeat(65), 'ünï']) {
    assert.equal(resolveCapConfig({ CLAUDE_CAP_PROFILE: profile }, (message) => warnings.push(message)).profile, CAP_DEFAULT_PROFILE, profile);
  }
  assert.equal(warnings.length, 10);
  assert.ok(warnings.every((message) => message.includes('CLAUDE_CAP_')));
});

test('the cap env names the proxy on every URL variable, the profile header, the placeholder key and Claude model names', () => {
  const env = capSessionEnv({ url: 'http://127.0.0.1:34817', profile: 'foreman-worker' });
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
    ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
    CLAUDE_AGENT_API_BASE_URL: 'http://127.0.0.1:34817/profile/foreman-worker',
    ANTHROPIC_LLM_HOST: 'http://127.0.0.1:34817/profile/foreman-worker',
    ANTHROPIC_API_KEY: CAP_DUMMY_API_KEY,
    ANTHROPIC_CUSTOM_HEADERS: 'x-claude-cap-profile: foreman-worker',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
  });
  assert.match(CAP_DUMMY_API_KEY, /dummy/);
});

test('every model name the CLI picks by itself is a Claude name a profile rule can match (claude-opus / sonnet / haiku / fable)', () => {
  assert.ok(Object.keys(CAP_MODEL_ENV).includes('ANTHROPIC_SMALL_FAST_MODEL'));
  for (const [name, model] of Object.entries(CAP_MODEL_ENV)) {
    assert.match(model, /^claude-(opus|sonnet|haiku|fable)/, name);
  }
});

test('applying cap billing removes every credential and provider switch from the child env and keeps the rest', () => {
  const ambient: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1000',
    ANTHROPIC_AUTH_TOKEN: 'proxy-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh',
    ANTHROPIC_API_KEY: 'sk-ant-real-key',
    ANTHROPIC_BASE_URL: 'http://elsewhere.invalid',
    ANTHROPIC_CUSTOM_HEADERS: 'x-other: 1',
    ANTHROPIC_MODEL: 'some-other-model',
    CLAUDE_CODE_SUBAGENT_MODEL: 'some-other-model',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
    AWS_BEARER_TOKEN_BEDROCK: 'aws',
  };
  const options: { env?: Record<string, string | undefined>; settings?: Record<string, unknown> } = { env: { ...ambient } };
  const config = applyCapBilling(options, {});

  assert.deepEqual(config, { url: CAP_DEFAULT_URL, profile: CAP_DEFAULT_PROFILE });
  const env = options.env as Record<string, string>;
  for (const name of CAP_SCRUBBED_ENV) {
    assert.equal(name in env, false, name);
  }
  // Everything unrelated is kept as it was.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/someone');
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '1000');
  // The key is the placeholder, never the one that was there.
  assert.equal(env.ANTHROPIC_API_KEY, CAP_DUMMY_API_KEY);
  assert.equal(env.ANTHROPIC_BASE_URL, `${CAP_DEFAULT_URL}/profile/foreman-worker`);
  assert.equal(env.ANTHROPIC_LLM_HOST, `${CAP_DEFAULT_URL}/profile/foreman-worker`);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: foreman-worker');
  assert.equal(JSON.stringify(options).includes('sk-ant-real-key'), false);
  assert.equal(JSON.stringify(options).includes('proxy-token'), false);
});

test('the flag-level settings carry the same values plus an empty token, and keep settings the run already had', () => {
  const options: { env?: Record<string, string | undefined>; settings?: Record<string, unknown> } = {
    env: {},
    settings: { ultracode: true, enableWorkflows: true, env: { SOMETHING_ELSE: 'kept', ANTHROPIC_BASE_URL: 'http://old.invalid' } },
  };
  applyCapBilling(options, { CLAUDE_CAP_URL: 'http://127.0.0.1:5555', CLAUDE_CAP_PROFILE: 'p1' });
  const settings = options.settings as { ultracode: boolean; enableWorkflows: boolean; env: Record<string, string> };
  assert.equal(settings.ultracode, true);
  assert.equal(settings.enableWorkflows, true);
  assert.equal(settings.env.SOMETHING_ELSE, 'kept');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555/profile/p1');
  assert.equal(settings.env.ANTHROPIC_LLM_HOST, 'http://127.0.0.1:5555/profile/p1');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, 'x-claude-cap-profile: p1');
  assert.equal(settings.env.ANTHROPIC_API_KEY, CAP_DUMMY_API_KEY);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, '');
  for (const [name, model] of Object.entries(CAP_MODEL_ENV)) {
    assert.equal(settings.env[name], model, name);
  }
});

test('applying cap billing twice gives the same options', () => {
  const once: { env?: Record<string, string | undefined>; settings?: Record<string, unknown> } = { env: { A: '1' } };
  applyCapBilling(once, {});
  const twice = structuredClone(once);
  applyCapBilling(twice, {});
  assert.deepEqual(twice, once);
});

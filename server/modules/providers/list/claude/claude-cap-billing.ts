/**
 * `cap` billing: a Claude session that runs through claude-cap's worker routing profile.
 *
 * claude-cap (a local proxy, `http://127.0.0.1:34817`) answers a request that carries the header
 * `x-claude-cap-profile: <profile>` by rewriting every Claude model name to the profile's upstream
 * (DeepSeek, pay per token, for `foreman-worker`) and by replacing whatever credentials the client
 * sent with the upstream's own. A cap session therefore never needs, and must never be handed, an
 * Anthropic credential: the CLI starts with a placeholder API key and nothing else.
 *
 * The user's `~/.claude/settings.json` has an `env` block (the proxy URL and its token, among others),
 * and a settings `env` beats the process environment of the CLI child (measured: with both set, the
 * CLI used the settings value). The cap values are therefore also written into the flag-level
 * `settings` of the run, which outranks the user, project and local settings files. Only a managed
 * (enterprise) policy would outrank it, and none is installed.
 */

/** The claude-cap proxy every cap session talks to unless `CLAUDE_CAP_URL` says otherwise. */
export const CAP_DEFAULT_URL = 'http://127.0.0.1:34817';

/** The claude-cap profile cap sessions select unless `CLAUDE_CAP_PROFILE` says otherwise. */
export const CAP_DEFAULT_PROFILE = 'foreman-worker';

/** The header with which a request selects a claude-cap routing profile. */
export const CAP_PROFILE_HEADER = 'x-claude-cap-profile';

/** The API key a cap session starts with. claude-cap ignores it; the CLI only needs some key to use the API-key path. */
export const CAP_DUMMY_API_KEY = 'sk-ant-cap-dummy-not-used';

/**
 * Claude model names for every model the CLI picks by itself (aliases, subagents, titles, summaries). A profile rewrites
 * a request by the substring of the model name (`claude-opus`, `claude-sonnet`, `claude-haiku`, `claude-fable`), so each of
 * these must be a real Claude name or the profile answers `profile_no_match`.
 */
export const CAP_MODEL_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
};

/**
 * Variables removed from the CLI child's environment in a cap session: every credential it could use (the proxy token,
 * OAuth tokens), a model override that could name something the profile does not map, and the switches that would send
 * the CLI to another provider altogether.
 */
export const CAP_SCRUBBED_ENV: readonly string[] = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
];

// A profile name travels in a header: keep it to the characters a claude-cap profile name can have.
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type CapConfig = {
  /** Base URL of the claude-cap proxy, without a trailing slash. */
  url: string;
  /** Name of the routing profile. */
  profile: string;
};

type EnvLike = Record<string, string | undefined>;

function readCapUrl(raw: string | undefined, warn: (message: string) => void): string {
  const value = raw?.trim();
  if (!value) {
    return CAP_DEFAULT_URL;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return value.replace(/\/+$/, '');
    }
  } catch {
    // Falls through to the warning below.
  }
  warn(`CLAUDE_CAP_URL is not an http(s) URL; using ${CAP_DEFAULT_URL}.`);
  return CAP_DEFAULT_URL;
}

/**
 * Where cap sessions go and under which profile: `CLAUDE_CAP_URL` (default `http://127.0.0.1:34817`) and
 * `CLAUDE_CAP_PROFILE` (default `foreman-worker`). A malformed value is reported and replaced by the default.
 */
export function resolveCapConfig(env: EnvLike = process.env, warn: (message: string) => void = console.warn): CapConfig {
  const profileRaw = env.CLAUDE_CAP_PROFILE?.trim();
  let profile = CAP_DEFAULT_PROFILE;
  if (profileRaw) {
    if (PROFILE_NAME_PATTERN.test(profileRaw)) {
      profile = profileRaw;
    } else {
      warn(`CLAUDE_CAP_PROFILE is not a valid profile name; using ${CAP_DEFAULT_PROFILE}.`);
    }
  }
  return { url: readCapUrl(env.CLAUDE_CAP_URL, warn), profile };
}

/**
 * The URL that selects the profile in the path: `<proxy>/profile/<profile>`. claude-cap routes by it, so a request that reaches the
 * proxy by any client setting is still answered by the profile's upstream. The header names the same profile (a different one is a
 * 400 `profile_conflict`).
 */
export function capProfileUrl(config: CapConfig): string {
  return `${config.url}/profile/${config.profile}`;
}

/**
 * The variables a cap session sets, as the CLI has to see them. The same set goes into the child's process environment
 * and into the run's flag-level settings.
 *
 * `ANTHROPIC_BASE_URL` carries the traffic on the API-key path and `ANTHROPIC_LLM_HOST` on the patched CLI's inference path
 * (the subscription route); both name the profile URL so that no path can reach Anthropic directly. A session handed over by the owner
 * has no `@cap` marker and never gets these.
 */
export function capSessionEnv(config: CapConfig): Record<string, string> {
  const profileUrl = capProfileUrl(config);
  return {
    ANTHROPIC_BASE_URL: profileUrl,
    ANTHROPIC_API_BASE_URL: profileUrl,
    CLAUDE_AGENT_API_BASE_URL: profileUrl,
    ANTHROPIC_LLM_HOST: profileUrl,
    ANTHROPIC_API_KEY: CAP_DUMMY_API_KEY,
    ANTHROPIC_CUSTOM_HEADERS: `${CAP_PROFILE_HEADER}: ${config.profile}`,
    ...CAP_MODEL_ENV,
  };
}

type SdkOptionsWithEnv = {
  env?: Record<string, string | undefined>;
  settings?: Record<string, unknown>;
};

/**
 * Turns the SDK options of a run into those of a cap session (in place): the proxy URL, the profile header, the
 * placeholder key and the model names in both the child's environment and the flag-level settings, with every real
 * credential removed from the environment and the settings file's `ANTHROPIC_AUTH_TOKEN` blanked.
 */
export function applyCapBilling(sdkOptions: SdkOptionsWithEnv, env: EnvLike = process.env): CapConfig {
  const config = resolveCapConfig(env);
  const capEnv = capSessionEnv(config);
  const childEnv: Record<string, string | undefined> = { ...sdkOptions.env };
  for (const name of CAP_SCRUBBED_ENV) {
    delete childEnv[name];
  }
  sdkOptions.env = { ...childEnv, ...capEnv };
  const previousEnv = (sdkOptions.settings?.env ?? {}) as Record<string, string>;
  sdkOptions.settings = {
    ...sdkOptions.settings,
    // An empty token wins over the settings file's own `ANTHROPIC_AUTH_TOKEN` (measured), so no Authorization header is sent.
    env: { ...previousEnv, ...capEnv, ANTHROPIC_AUTH_TOKEN: '' },
  };
  return config;
}

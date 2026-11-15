const REDACTED = '[redacted]';

/** A secret shorter than this is not one the token guard (`foreman-next.token.ts`) would have accepted, and replacing a short word would eat ordinary text. */
const MIN_SECRET_LENGTH = 16;

/**
 * What a log line may carry that must not leave this server, by its shape: a credential after `Bearer`, the value of a name that says it is
 * secret (`API_KEY=…`, `"token": "…"`), and the keys that look like keys on their own. A 64-digit hex string is what `openssl rand -hex 32` makes, which is
 * how Foreman's tokens are made; 41 digits and up leaves a 40-digit commit id readable. A value that follows a name takes its scheme word with it, so
 * `Authorization: Bearer x` and `Authorization: Basic x` leave nothing of the credential behind.
 */
const SHAPES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(bearer)\s+[^\s'",;]{8,}/gi, replacement: `$1 ${REDACTED}` },
  { pattern: /(\b[\w.-]{0,40}(?:token|secret|passw(?:or)?d|api[_-]?key|authorization|credential)[\w.-]{0,40}["']?\s*[=:]\s*)(?:(?:bearer|basic)\s+)?("[^"]*"|'[^']*'|[^\s,;&]+)/gi, replacement: `$1${REDACTED}` },
  { pattern: /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|xox[abprs]-[\w-]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|[0-9a-f]{41,})\b/gi, replacement: REDACTED },
];

/**
 * A log line with every secret taken out: first the exact values this process holds (the proxy's own API token, read through the token guard), which no
 * shape could miss, then whatever has the shape of a credential.
 */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let clean = line;
  for (const secret of secrets) if (secret.length >= MIN_SECRET_LENGTH) clean = clean.split(secret).join(REDACTED);
  for (const { pattern, replacement } of SHAPES) clean = clean.replace(pattern, replacement);
  return clean;
}

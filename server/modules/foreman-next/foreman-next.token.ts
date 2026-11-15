import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

/** A token is 16 to 512 characters (Foreman asks for 16 at least; `openssl rand -hex 32` makes 64) of the set below: what can sit in a header value with nothing to escape. */
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;
const TOKEN_CHARACTERS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/=');

/** What was already said, so a poll that finds the same problem every time says it once; a different problem for the same file is said again. */
const reported = new Set<string>();

/** Refuses the file: the proxy answers as if there were no token. Says which file and what is wrong, once; never any of the content. */
function refuse(file: string, problem: string): null {
  const report = `${file}: ${problem}`;
  if (!reported.has(report)) {
    reported.add(report);
    console.error(`[Foreman next] token file ${report}. It is not used, so the proxy answers 503 until this is fixed.`);
  }
  return null;
}

/** What is wrong with the token itself (the file without its one line ending), or null if it is fine. The answer never holds a character of the token. */
function problemWithToken(token: string): string | null {
  if (token.length === 0) return 'it is blank';
  if (token.includes('\n') || token.includes('\r')) return 'it is not a single line: there is a line break or carriage return inside the token';
  if (token.length < MIN_TOKEN_LENGTH) return `the token is shorter than ${MIN_TOKEN_LENGTH} characters`;
  if (token.length > MAX_TOKEN_LENGTH) return `the token is longer than ${MAX_TOKEN_LENGTH} characters`;
  for (const character of token) {
    if (!TOKEN_CHARACTERS.has(character)) return 'the token has a character outside A-Z a-z 0-9 - . _ ~ + / = (a space, a control character or a non-ASCII one)';
  }
  return null;
}

/**
 * Foreman's API token, read fresh on every call so rotating it needs no restart. A token file must be one line, the token and at most one
 * trailing `\n` or `\r\n`, and readable by its owner only (no group or other bits): anything else is refused and treated as no token (null), so
 * the proxy answers 503 `FOREMAN_NOT_CONFIGURED` as it does for a missing file. A refusal is logged once per distinct problem with the path and
 * the mode, never the content; a missing file is just null.
 */
export async function readTokenFile(file: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : refuse(file, `it cannot be inspected (${typeof code === 'string' ? code : 'unknown error'})`);
  }
  if (!stats.isFile()) return refuse(file, 'it is not a regular file');
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) return refuse(file, `its mode is ${mode.toString(8).padStart(3, '0')}, which lets group or other users in; it must be accessible to its owner only (chmod 600)`);
  // One line and a line ending: a file larger than that is refused without being read.
  if (stats.size > MAX_TOKEN_LENGTH + 2) return refuse(file, `it is longer than a token file can be (${MAX_TOKEN_LENGTH} characters and a line ending)`);

  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? null : refuse(file, `it cannot be read (${typeof code === 'string' ? code : 'unknown error'})`);
  }
  const token = content.endsWith('\r\n') ? content.slice(0, -2) : content.endsWith('\n') ? content.slice(0, -1) : content;
  const problem = problemWithToken(token);
  return problem === null ? token : refuse(file, problem);
}

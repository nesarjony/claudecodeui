import os from 'node:os';
import path from 'node:path';

/**
 * The secret classes a guarded session always protects (Milestone 5 hardening), on top of the patterns Foreman sends.
 *
 * Foreman's `secretPatterns` are regular expressions over the text of a call. They are good at "this text mentions
 * `.env`", but they do not know where a path really points (`~/.config/gh/hosts-token`, `$HOME/.ssh`), they do not see a
 * glob whose wildcards can name a secret (`~/.config/**\/*token*`), and a config that leaves a class out leaves that
 * class unprotected. The classes below are code, not config, and always apply while the guard is enabled:
 *
 * - `.env*` files (except `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `id_rsa*` and `id_ed25519*`,
 *   `credentials*` files (a documentation file such as `credentials-guide.md` is not one);
 * - any file under `~/.config/` whose name is or contains `token`, `key`, `secret` or `credentials`;
 * - the secret directories `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/foreman` and `~/.config/task-queue-mcp`, and
 *   everything below them.
 *
 * Everything here is a pure function of its arguments (the home directory and working directory come in through
 * `SecretScope`), so the rules are testable without touching the machine. The judgement is a heuristic, not a sandbox: it
 * reads what a call says, so a command that builds a path at run time (`cat $(echo .e)nv`) can still slip through. It
 * exists to hold the plain and the common cases for a person, and it errs towards holding.
 */

/** Whose home directory is protected, and the directory relative paths are read against (the session's repo root). */
export type SecretScope = { home: string; cwd: string };

const SECRET_DIRECTORIES = ['.ssh', '.aws', '.gnupg', '.config/foreman', '.config/task-queue-mcp'];
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;
const CONFIG_SECRET_WORD = /token|key|secret|credentials/i;
const DOC_EXTENSION = /\.(md|mdx|rst|adoc)$/i;

/** The user's home directory, as a clean absolute path. */
// Consumed by compileGuard, which captures it once per compiled guard.
export function resolveHome(): string {
  return path.resolve(process.env.HOME || os.homedir());
}

/** Expands a leading `~` and any `$HOME` / `${HOME}` to the home directory. */
// Consumed by the guard classifier (write targets are expanded the way the CLI expands them) and the tests.
export function expandHome(value: string, home: string): string {
  return value.replace(/^~(?=$|\/)/, home).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
}

/** `{a,b}` alternatives written out (one level, bounded), so `*.{pem,key}` is seen as `*.pem` and `*.key`. */
function expandBraces(glob: string, budget = { left: 64 }): string[] {
  const open = glob.indexOf('{');
  const close = open === -1 ? -1 : glob.indexOf('}', open);
  if (open === -1 || close === -1 || budget.left <= 0) {
    return [glob];
  }
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return glob.slice(open + 1, close).split(',').flatMap((option) => {
    budget.left -= 1;
    return expandBraces(head + option + tail, budget);
  });
}

/** `[abc]` written out as `a`, `b`, `c` (plain classes only, bounded), so `.en[v]` is seen as `.env`. */
function expandClasses(glob: string, budget = { left: 64 }): string[] {
  const match = /\[([^\]\-!^]{1,8})\]/.exec(glob);
  if (!match || budget.left <= 0) {
    return [glob];
  }
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);
  return [...match[1]].flatMap((letter) => {
    budget.left -= 1;
    return expandClasses(head + letter + tail, budget);
  });
}

/**
 * The forms a file glob can take once its wildcards are filled in. The secret patterns end in a lookahead for the end of
 * a name, so `**\/.env*` or `.env.*` would never match as written; with braces and plain character classes written out
 * and each wildcard run dropped or replaced by a letter, the names such a glob can match are seen too. A glob that is
 * not one yields just itself. Character ranges (`[a-f]`) are treated as wildcards.
 */
// Consumed by the guard classifier (Glob and Grep file globs) and by the shell reader below.
export function globVariants(glob: string): string[] {
  const variants = expandBraces(glob).flatMap((option) => expandClasses(option)).flatMap((option) => [
    option,
    option.replace(/[*?]+|\[[^\]]*\]/g, ''),
    option.replace(/[*?]+|\[[^\]]*\]/g, 'x'),
  ]);
  return [...new Set(variants)];
}

/** Is a file called `base` (no directory part) a documentation file about credentials rather than one that holds them? */
function isCredentialsFile(base: string): boolean {
  if (!/^credentials/i.test(base)) {
    return false;
  }
  // `credentials-guide.md` is about credentials; `credentials`, `credentials.json`, `credentials.md` and `credentials_prod` hold them.
  return !(/^credentials[-_]/i.test(base) && DOC_EXTENSION.test(base));
}

/** The last name in a path as it was written (not resolved), or '' when it ends in a slash or is `.` or `..`. */
function writtenBase(value: string): string {
  if (value.endsWith('/')) {
    return '';
  }
  const base = value.slice(value.lastIndexOf('/') + 1);
  return base === '.' || base === '..' ? '' : base;
}

/** Why one concrete path (no wildcards) is a secret, or null. */
function labelOf(variant: string, scope: SecretScope): string | null {
  if (!variant.trim()) {
    return null;
  }
  const expanded = expandHome(variant, scope.home);
  const absolute = path.resolve(scope.cwd, expanded);
  for (const relative of SECRET_DIRECTORIES) {
    const directory = path.join(scope.home, relative);
    if (absolute === directory || absolute.startsWith(directory + path.sep)) {
      return `a secrets directory (~/${relative})`;
    }
  }
  const base = writtenBase(expanded);
  if (!base) {
    return null;
  }
  if (/^\.env/i.test(base) && !ENV_TEMPLATE.test(base)) {
    return 'a .env file';
  }
  if (/\.pem$/i.test(base)) {
    return 'a .pem file';
  }
  if (/^id_(rsa|ed25519)/i.test(base)) {
    return 'an SSH private key';
  }
  if (isCredentialsFile(base)) {
    return 'a credentials file';
  }
  if (absolute.startsWith(path.join(scope.home, '.config') + path.sep) && CONFIG_SECRET_WORD.test(base)) {
    return 'a file in ~/.config named like a token, key or secret';
  }
  return null;
}

/**
 * Why a path, or a glob that can match one, is a secret by the built-in classes; null when it is not. `~` and `$HOME` are
 * expanded and relative paths are read against `scope.cwd`. A trailing slash (or a wildcard dropped from the end of a
 * directory) names a directory, which only the secret-directory rule applies to.
 */
// Consumed by the guard classifier for every path argument and file glob, and by the tests.
export function secretPathLabel(value: string, scope: SecretScope): string | null {
  for (const variant of globVariants(value)) {
    const label = labelOf(variant, scope);
    if (label) {
      return label;
    }
  }
  return null;
}

/** The directories that contain a secrets directory: a recursive search from one of them reaches the secrets. */
function secretDirectoryAncestors(scope: SecretScope, includeRoot: boolean): string[] {
  const ancestors = [scope.home, path.join(scope.home, '.config')];
  if (includeRoot) {
    ancestors.push(path.dirname(scope.home), path.parse(scope.home).root);
  }
  return [...new Set(ancestors)].filter((directory) => directory !== scope.cwd);
}

/**
 * Is `value` an absolute directory that holds a secrets directory (`~`, `~/.config`; with `includeRoot` also `/home`, `/`)?
 * A recursive search that starts there reads the secrets without naming them. Relative values never count: `.` is the
 * session's own project, and a project that is itself one of these directories is never held for being searched.
 */
// Consumed by the guard classifier for the `path` of Grep and Glob and for recursive shell commands, and by the tests.
export function coversSecretDirectories(value: string, scope: SecretScope, includeRoot: boolean): boolean {
  const expanded = expandHome(value, scope.home);
  if (!expanded.startsWith('/')) {
    return false;
  }
  const resolved = path.resolve(expanded);
  return secretDirectoryAncestors(scope, includeRoot).includes(resolved);
}

/**
 * The directory and name filters a search call carries, as paths a secret could hide in. `base` is the call's `path`
 * (or the working directory); each glob is joined to it unless it is already absolute, so `path: ~/.config` with glob
 * `*token*` is seen as `~/.config/*token*`.
 */
// Consumed by the guard classifier for Glob (`pattern`) and for any tool's `glob` / `include`, and by the tests.
export function searchTargetLabel(base: string | undefined, globs: string[], scope: SecretScope): string | null {
  for (const glob of globs) {
    const joined = /^(\/|~(\/|$)|\$\{?HOME\}?)/.test(glob) ? glob : `${base ?? '.'}/${glob}`;
    const label = secretPathLabel(joined, scope);
    if (label) {
      return label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------------------------

const MAX_COMMAND_LENGTH = 100_000;
const MAX_NESTING = 3;
const MAX_WORDS = 4000;

/** Commands that run the command that follows them; the verb of the segment is the word after these. */
const WRAPPER_COMMANDS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'stdbuf', 'timeout',
  'watch', 'setsid',
]);

/** Commands that walk a whole directory tree, so naming `~` or `~/.config` to them reads whatever is inside. */
const TREE_WALKERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'tar', 'zip', 'rsync', 'scp', 'cp', '7z', '7za', 'bsdtar']);

/**
 * Splits a shell command into simple commands, each a list of words with quoting and backslashes removed. `;`, `&`, `|`,
 * newlines, parentheses and backticks end a command; redirection operators only end a word, so `cat < .env` and
 * `cat<.env` both give `cat` and `.env`. A word that itself holds shell syntax (the script of `bash -c '...'`, the body
 * of `"$(cat .env)"`) is read again as a command of its own.
 */
function shellCommands(input: string, depth = 0, budget = { nested: 300 }): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && index + 1 < input.length && '"\\$`'.includes(input[index + 1])) {
        index += 1;
        word += input[index];
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\') {
      if (index + 1 < input.length && input[index + 1] !== '\n') {
        index += 1;
        word += input[index];
        inWord = true;
      } else {
        index += 1;
      }
    } else if (char === '\n' || ';&|()`'.includes(char)) {
      endCommand();
    } else if (/\s/.test(char) || char === '<' || char === '>') {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();

  if (depth < MAX_NESTING) {
    const nested = commands.flat().filter((entry) => /[\s;&|<>()`]/.test(entry));
    for (const entry of nested) {
      if (budget.nested <= 0) {
        break;
      }
      budget.nested -= 1;
      commands.push(...shellCommands(entry, depth + 1, budget));
    }
  }
  return commands;
}

/** The forms in which a path can appear inside one word: `--file=.env`, `-d@.env`, `host:~/.ssh/id_rsa`, `NAME=.env`. */
function pathCandidates(word: string): string[] {
  const stripAt = (value: string) => (value.includes('@') ? value.slice(value.indexOf('@') + 1) : value);
  const afterEquals = word.includes('=') ? word.slice(word.indexOf('=') + 1) : null;
  const afterColon = word.includes(':') ? word.slice(word.lastIndexOf(':') + 1) : null;
  const candidates = [word, stripAt(word)];
  if (afterEquals !== null) {
    candidates.push(afterEquals, stripAt(afterEquals));
  }
  if (afterColon !== null) {
    candidates.push(afterColon);
  }
  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

/** Index of the word that is the program of a command: past `VAR=value` assignments and wrappers such as `sudo -u x`. */
function verbIndex(words: string[]): number {
  let wrapped = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      continue;
    }
    if (WRAPPER_COMMANDS.has(path.basename(word))) {
      wrapped = true;
      continue;
    }
    if (wrapped && (word.startsWith('-') || /^\d+[smhd]?$/.test(word))) {
      continue;
    }
    return index;
  }
  return -1;
}

/**
 * Why a shell command reads, copies, sources, redirects from or otherwise names a secret by the built-in classes; null when
 * it does not. Every word of every simple command is judged as a path (so `cat`, `less`, `head`, `grep`, `sed`, `awk`,
 * `xxd`, `base64`, `cp`, `scp`, `rsync`, `tar`, `zip`, `source`, `. file`, `< file`, `$(cat file)`, `curl -d @file` and
 * a pipe out of any of them are all seen without a list of verbs), with `cd` followed so `cd ~/.ssh && cat id_rsa` is
 * judged where `id_rsa` really is. A directory walker (`grep -r`, `find`, `tar`, ...) pointed at `~` or `~/.config`
 * is held too, since it reaches the secrets below. Plain words such as `token` or `src/` are not paths to a secret, so
 * `grep -r "token" src/` stays allowed.
 */
// Consumed by the guard classifier for Bash calls, and by the tests.
export function bashSecretLabel(command: string, scope: SecretScope): string | null {
  if (command.length > MAX_COMMAND_LENGTH) {
    return 'a command too long to judge';
  }
  let cwd = scope.cwd;
  let judged = 0;
  for (const words of shellCommands(command)) {
    const verbAt = verbIndex(words);
    const verb = verbAt === -1 ? '' : path.basename(words[verbAt]);
    const here: SecretScope = { home: scope.home, cwd };
    for (const word of words) {
      judged += 1;
      if (judged > MAX_WORDS) {
        return 'a command too long to judge';
      }
      for (const candidate of pathCandidates(word)) {
        const label = secretPathLabel(candidate, here);
        if (label) {
          return label;
        }
      }
      if (TREE_WALKERS.has(verb) && coversSecretDirectories(word, here, false)) {
        return 'a directory search that reaches secrets (~ or ~/.config)';
      }
    }
    if ((verb === 'cd' || verb === 'pushd') && verbAt !== -1) {
      const target = words.slice(verbAt + 1).find((word) => !word.startsWith('-'));
      if (target) {
        cwd = path.resolve(cwd, expandHome(target, scope.home));
      }
    }
  }
  return null;
}

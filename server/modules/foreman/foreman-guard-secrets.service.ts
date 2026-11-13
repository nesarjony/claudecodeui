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

/** One entry of a directory listing. A link to a directory counts as a directory. */
export type DirEntry = { name: string; dir: boolean };

/** Lists a directory: its entries, `[]` when it is missing or is not a directory, `null` when it cannot be read or is too big to judge. */
export type DirLister = (dir: string) => DirEntry[] | null;

/**
 * Whose home directory is protected, and the directory relative paths are read against (the session's repo root).
 *
 * - `list` lets a wildcard in a read-only command be resolved against the file system, so the command is judged by the files it really names.
 *   Without it every wildcard is judged by its shape (`.*`, `id_*`, `*.pem` can match a secret).
 * - `real` resolves links, so a file a wildcard matches is judged where its link leads.
 * - `patterns` are the configured secret path patterns. They are regular expressions over a PATH, so they are applied to the words of a
 *   command, to its redirection targets and to resolved matches, and never to the text of an inline script or to a regular expression.
 */
export type SecretScope = { home: string; cwd: string; list?: DirLister; patterns?: RegExp[]; real?: (path: string) => string };

const SECRET_DIRECTORIES = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.terraform.d', '.config/foreman', '.config/task-queue-mcp', '.config/claude-api', '.config/gh', '.config/gcloud', '.config/doctl', '.config/rclone'];
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
  return [...match[1]!].flatMap((letter) => {
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


/** Names a wildcard is worth holding for: what it can expand to when its literal start (or end) is the start (or end) of one of these. */
const SECRET_NAME_STARTS = ['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'secrets', '.netrc', '.npmrc', '.pgpass', '.git-credentials', '.aws', '.ssh', '.gnupg', '.kube', '.docker'];
const SECRET_NAME_ENDS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.tfstate'];

/** A glob (`.en*`, `id_*`, `*.pem`, `.*`) that can expand to a secret file. A bare `*` does not match dotfiles and is not held. */
function wildcardSecretLabel(value: string): string | null {
  const base = value.slice(value.lastIndexOf('/') + 1);
  const at = base.search(/[*?[]/);
  if (at === -1) {
    return null;
  }
  const prefix = base.slice(0, at).toLowerCase();
  const suffix = base.slice(base.search(/[^*?\]\[]*$/)).toLowerCase();
  if (prefix === '.' || (prefix.length >= 2 && SECRET_NAME_STARTS.some((name) => name.startsWith(prefix)))) {
    return 'a wildcard that can match a secret file';
  }
  if (suffix.length >= 3 && SECRET_NAME_ENDS.some((end) => end.endsWith(suffix) || suffix.endsWith(end))) {
    return 'a wildcard that can match a key file';
  }
  return null;
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
  if (/^id_(rsa|dsa|ecdsa|ed25519)/i.test(base)) {
    return 'an SSH private key';
  }
  if (/^\.(netrc|npmrc|pypirc|pgpass|my\.cnf|git-credentials|s3cfg|boto|vault-token|claude\.json|credentials(\..*)?)$/i.test(base)) {
    return 'a credentials file';
  }
  if (/^\.(bash|zsh|sh|psql|mysql|node_repl|python|rediscli)_?history$/i.test(base)) {
    return 'a shell or client history file';
  }
  if (/\.tfstate(\.backup)?$/i.test(base) || /\.(p12|pfx|jks|keystore|kdbx|ovpn)$/i.test(base)) {
    return 'a state, keystore or key file';
  }
  if (/(service[-_]?account|[-_.](key|keys|secret|secrets|token|tokens|credential|credentials))[^/]*\.(json|ya?ml|toml|ini|txt|cfg|conf|properties|xml)$/i.test(base) || /^(secrets?|tokens?|credentials?)\.(json|ya?ml|toml|ini|txt|cfg|conf|properties|xml)$/i.test(base)) {
    return 'a file named like a credential';
  }
  if (/^\/proc\/[^/]+\/environ$/.test(absolute)) {
    return 'a process environment (/proc/*/environ)';
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
// `wildcard: false` is for a path that is already concrete (a resolved match): its `*` and `[` are part of a name, not a pattern.
export function secretPathLabel(value: string, scope: SecretScope, options: { wildcard?: boolean } = {}): string | null {
  const concrete = options.wildcard === false;
  if (!concrete) {
    const wild = wildcardSecretLabel(value);
    if (wild) {
      return wild;
    }
  }
  const variants = concrete ? [value] : globVariants(value);
  for (const variant of variants) {
    const label = labelOf(variant, scope);
    if (label) {
      return label;
    }
  }
  for (const re of scope.patterns ?? []) {
    if (variants.some((variant) => re.test(variant))) {
      return re.source;
    }
  }
  return null;
}

const GLOB_WORD = /[*?[]|\{[^}]*,[^}]*\}/;
const MAX_GLOB_ENTRIES = 20_000;
export const MAX_GLOB_MATCHES = 5000;

/** Does this word hold something the shell expands into file names? */
export function isGlobWord(word: string): boolean {
  return GLOB_WORD.test(word);
}

/** One path segment of a glob as a regular expression (`*`, `?`, `[...]`), or null for a form this reader does not understand. */
function segmentMatcher(segment: string): RegExp | null {
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = segment.indexOf(']', index + 2);
      if (close === -1) {
        source += '\\[';
        continue;
      }
      let body = segment.slice(index + 1, close);
      if (body.startsWith('!')) {
        body = `^${body.slice(1)}`;
      }
      if (/\[:|\[\.|\[=/.test(body)) {
        return null;
      }
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      index = close;
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

/**
 * The paths a wildcard word really names: brace alternatives written out, `*` `?` `[...]` matched against the directory listings of
 * `scope.list`. A shell leaves names that start with a dot out of `*`, but a shell option (`shopt -s dotglob`) or another tool does not, so
 * here they are matched too: a `.env` next to the files a command names is a hold, as it is for a person reading the command. `**` is not
 * understood and counts as unresolvable. A segment without a wildcard is kept as written, whether it exists or not. Null when the word
 * cannot be resolved here (no lister, a run-time value in it, a directory that cannot be read, too many entries or matches), which the
 * caller judges by the shape of the glob instead.
 */
// Consumed by `bashSecretLabel` for the wildcards of a read-only command, and by the tests.
export function globMatches(pattern: string, scope: SecretScope, cwd = scope.cwd): string[] | null {
  const list = scope.list;
  if (!list || /\*\*|[$`\u0001]/.test(pattern)) {
    return null;
  }
  const budget = { entries: MAX_GLOB_ENTRIES };
  const found = new Set<string>();
  for (const alternative of expandBraces(expandHome(pattern, scope.home))) {
    if (/\{[^}]*,/.test(alternative)) {
      return null;
    }
    let frontier = [alternative.startsWith('/') ? '/' : cwd];
    const segments = alternative.split('/').filter((segment) => segment !== '' && segment !== '.');
    for (const [position, segment] of segments.entries()) {
      if (!/[*?[]/.test(segment)) {
        frontier = frontier.map((directory) => path.join(directory, segment));
        continue;
      }
      const matcher = segmentMatcher(segment);
      if (!matcher) {
        return null;
      }
      const last = position === segments.length - 1;
      const next: string[] = [];
      for (const directory of frontier) {
        const entries = list(directory);
        if (entries === null) {
          return null;
        }
        budget.entries -= entries.length;
        if (budget.entries < 0) {
          return null;
        }
        for (const entry of entries) {
          if (!matcher.test(entry.name) || (!last && !entry.dir)) {
            continue;
          }
          next.push(path.join(directory, entry.name));
        }
      }
      if (next.length > MAX_GLOB_MATCHES) {
        return null;
      }
      frontier = next;
    }
    for (const match of frontier) {
      found.add(match);
    }
    if (found.size > MAX_GLOB_MATCHES) {
      return null;
    }
  }
  return [...found];
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

/** One simple command as the reader sees it. */
export interface SimpleCommand {
  /** The words, quoting and backslashes removed. */
  words: string[];
  /** Words that had a quote or a backslash in them: the shell does not expand a wildcard in those. */
  quoted: boolean[];
  /** Words that are program text or a pattern, not a path: an `awk` or `sed` program, a `grep` pattern, a `jq` filter, the code of `node -e` or `python -c`. (The `-name` pattern of `find` is not among them: what `find` lists can be piped into a reader.) */
  literal: Set<number>;
  /** Words that were read again as commands of their own (they hold shell syntax). */
  expanded: Set<number>;
}

const AWK_VERBS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const GREP_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const GREP_VALUE_OPTIONS = new Set(['-m', '-A', '-B', '-C', '-d', '-D', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--include-dir', '--label', '--directories', '--devices', '--binary-files']);
const RG_VALUE_OPTIONS = new Set(['-m', '-A', '-B', '-C', '-g', '-t', '-T', '-j', '-M', '-r', '-E', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--threads', '--max-columns', '--replace', '--encoding', '--max-depth', '--maxdepth', '--max-filesize', '--sort', '--sortr', '--pre', '--pre-glob', '--engine', '--colors', '--path-separator', '--ignore-file', '--max-count', '--context', '--after-context', '--before-context', '--dfa-size-limit', '--regex-size-limit', '--context-separator', '--field-match-separator', '--field-context-separator', '--hostname-bin', '--hyperlink-format']);
const AG_VALUE_OPTIONS = new Set(['-A', '-B', '-C', '-G', '-m', '-g', '--depth', '--ignore', '--ignore-dir', '--file-search-regex', '--context', '--after', '--before', '--max-count']);
const JQ_VALUE_OPTIONS = new Set(['--indent', '--tab', '-L', '--seq']);
const JQ_TWO_VALUE_OPTIONS = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']);
const GIT_PATTERN_OPTIONS = new Set(['-e', '-G', '-S', '--grep', '--author', '--committer', '--pickaxe-regex']);
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

/** The flag that puts code on the command line of an interpreter (`node -e`, `python -c`, `perl -e`, `php -r`); null when `verb` is not one. */
function inlineCodeFlag(verb: string): RegExp | null {
  if (/^(node|nodejs|bun|tsx|ts-node)$/.test(verb)) {
    return /^(-e|-p|--eval|--print|-pe|-ep)$/;
  }
  if (/^python[0-9.]*$/.test(verb)) {
    return /^-[A-Za-z]*c$/;
  }
  if (/^(ruby|perl)[0-9.]*$/.test(verb)) {
    return /^-[A-Za-z]*[eE]$/;
  }
  if (/^php[0-9.]*$/.test(verb)) {
    return /^-r$/;
  }
  if (/^(lua[0-9.]*|rscript)$/.test(verb)) {
    return /^-e$/;
  }
  return null;
}

/**
 * Which words of one command are program text or a pattern rather than a path (indexes into `words`). The text of a program or a
 * regular expression is full of `.*`, `.key` and `|`; read as a path it is held for being a wildcard that can match a secret, or a
 * name that ends in `.key`. The path-like arguments of the same command (the files it reads) are still judged as paths.
 * A wrong guess costs one word its judgement; it is made only for verbs whose argument syntax is known.
 */
// Consumed by the shell reader below and by the structural reader of `shell.ts` through `shellCommands`.
export function patternWordIndexes(words: string[]): Set<number> {
  const out = new Set<number>();
  const at = verbIndex(words);
  if (at === -1) {
    return out;
  }
  const verb = path.basename(words[at]!).toLowerCase();
  const args = words.slice(at + 1);
  const mark = (k: number) => {
    if (k < args.length) {
      out.add(at + 1 + k);
    }
  };
  if (AWK_VERBS.has(verb)) {
    let given = false;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k]!;
      if (a === '--') {
        if (!given) {
          mark(k + 1);
        }
        break;
      }
      if (a === '-e' || a === '--source') {
        mark(k + 1);
        given = true;
        k += 1;
      } else if (a === '-f' || a === '--file' || a === '-E') {
        given = true;
        k += 1;
      } else if (['-F', '-v', '-i', '-l', '-W'].includes(a)) {
        k += 1;
      } else if (a.startsWith('-') && a.length > 1) {
        continue;
      } else {
        if (!given) {
          mark(k);
        }
        break;
      }
    }
  } else if (verb === 'sed') {
    let given = false;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k]!;
      if (a === '--') {
        if (!given) {
          mark(k + 1);
        }
        break;
      }
      if (a === '-e' || a === '--expression') {
        mark(k + 1);
        given = true;
        k += 1;
      } else if (a.startsWith('--expression=')) {
        mark(k);
        given = true;
      } else if (a === '-f' || a === '--file') {
        given = true;
        k += 1;
      } else if (a.startsWith('--file=')) {
        given = true;
      } else if (a === '-l' || a === '--line-length') {
        k += 1;
      } else if (/^-[A-Za-z]+$/.test(a) && /e$/.test(a)) {
        mark(k + 1);
        given = true;
        k += 1;
      } else if (/^-[A-Za-z]+$/.test(a) && /f$/.test(a)) {
        given = true;
        k += 1;
      } else if (a.startsWith('-') && a.length > 1) {
        continue;
      } else {
        if (!given) {
          mark(k);
        }
        break;
      }
    }
  } else if (GREP_VERBS.has(verb)) {
    const values = verb === 'rg' ? RG_VALUE_OPTIONS : verb === 'ag' || verb === 'ack' ? AG_VALUE_OPTIONS : GREP_VALUE_OPTIONS;
    let given = args.includes('--files') || args.includes('--type-list');
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k]!;
      if (a === '--') {
        if (!given) {
          mark(k + 1);
        }
        break;
      }
      if (a === '-e' || a === '--regexp') {
        mark(k + 1);
        given = true;
        k += 1;
      } else if (a.startsWith('--regexp=')) {
        mark(k);
        given = true;
      } else if (a === '-f' || a === '--file') {
        given = true;
        k += 1;
      } else if (a.startsWith('--file=')) {
        given = true;
      } else if (/^-[A-Za-z]{2,}$/.test(a) && /e$/.test(a) && !values.has(a)) {
        mark(k + 1);
        given = true;
        k += 1;
      } else if (/^-[A-Za-z]{2,}$/.test(a) && /f$/.test(a) && !values.has(a)) {
        given = true;
        k += 1;
      } else if (values.has(a)) {
        k += 1;
      } else if (a.startsWith('-') && a.length > 1) {
        continue;
      } else {
        if (!given) {
          mark(k);
        }
        break;
      }
    }
  } else if (verb === 'jq' || verb === 'yq') {
    let given = false;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k]!;
      if (a === '-f' || a === '--from-file') {
        given = true;
        k += 1;
      } else if (JQ_TWO_VALUE_OPTIONS.has(a)) {
        k += 2;
      } else if (JQ_VALUE_OPTIONS.has(a)) {
        k += 1;
      } else if (a.startsWith('-') && a.length > 1) {
        continue;
      } else {
        if (!given) {
          mark(k);
        }
        break;
      }
    }
  } else if (verb === 'git') {
    let k = 0;
    while (k < args.length && args[k]!.startsWith('-')) {
      k += GIT_GLOBAL_VALUE_OPTIONS.has(args[k]!.split('=')[0]!) && !args[k]!.includes('=') ? 2 : 1;
    }
    const sub = args[k];
    if (sub === 'grep') {
      let given = false;
      for (let j = k + 1; j < args.length; j += 1) {
        const a = args[j]!;
        if (a === '--') {
          break;
        }
        if (a === '-e') {
          mark(j + 1);
          given = true;
          j += 1;
        } else if (['-A', '-B', '-C', '-m', '--max-depth', '-f'].includes(a)) {
          j += 1;
        } else if (!a.startsWith('-')) {
          if (!given) {
            mark(j);
          }
          break;
        }
      }
    } else if (sub !== undefined) {
      for (let j = k + 1; j < args.length; j += 1) {
        const a = args[j]!;
        if (GIT_PATTERN_OPTIONS.has(a)) {
          mark(j + 1);
        } else if (/^(--grep|--author|--committer)=/.test(a) || /^-[GS].+/.test(a)) {
          mark(j);
        }
      }
    }
  } else {
    const flag = inlineCodeFlag(verb);
    if (flag) {
      for (let k = 0; k < args.length; k += 1) {
        if (flag.test(args[k]!)) {
          mark(k + 1);
        }
      }
    }
  }
  return out;
}

/**
 * Splits a shell command into simple commands, each a list of words with quoting and backslashes removed. `;`, `&`, `|`,
 * newlines, parentheses and backticks end a command; redirection operators only end a word, so `cat < .env` and
 * `cat<.env` both give `cat` and `.env`. A word that itself holds shell syntax (the script of `bash -c '...'`, the body
 * of `"$(cat .env)"`) is read again as a command of its own. The text of a program or a pattern (`literal`) is read again too,
 * but what comes out of it is program text as well, never a path.
 */
function shellCommands(input: string, depth = 0, budget = { nested: 300 }, inProgram = false): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let quoted: boolean[] = [];
  let word = '';
  let inWord = false;
  let wordQuoted = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) {
      words.push(word);
      quoted.push(wordQuoted || depth > 0);
    }
    word = '';
    inWord = false;
    wordQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push({ words, quoted, literal: inProgram ? new Set(words.keys()) : patternWordIndexes(words), expanded: new Set() });
    }
    words = [];
    quoted = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
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
      } else if (char === '\\' && index + 1 < input.length && '"\\$`'.includes(input[index + 1]!)) {
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
      wordQuoted = true;
    } else if (char === '\\') {
      if (index + 1 < input.length && input[index + 1] !== '\n') {
        index += 1;
        word += input[index];
        inWord = true;
        wordQuoted = true;
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
    for (const command of [...commands]) {
      for (const [k, entry] of command.words.entries()) {
        if (!/[\s;&|<>()`]/.test(entry)) {
          continue;
        }
        if (budget.nested <= 0) {
          break;
        }
        budget.nested -= 1;
        command.expanded.add(k);
        commands.push(...shellCommands(entry, depth + 1, budget, inProgram || command.literal.has(k)));
      }
    }
  }
  return commands;
}

/** The forms in which a path can appear inside one word: `--file=.env`, `-d@.env`, `host:~/.ssh/id_rsa`, `NAME=.env`. */
export function pathCandidates(word: string): string[] {
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
    const word = words[index]!;
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

/** Commands that only read the files they are given: a wildcard in their arguments is judged by the files it really matches. */
const READ_ONLY_GLOB_VERBS = new Set([
  'cat', 'head', 'tail', 'nl', 'tac', 'wc', 'less', 'more', 'cut', 'strings', 'xxd', 'od', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'diff',
  'ls', 'stat', 'file', 'du', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'mawk', 'nawk', 'sed', 'find', 'git', 'jq', 'base64',
]);
export const READ_ONLY_GIT = new Set(['log', 'show', 'diff', 'blame', 'ls-files', 'ls-tree', 'grep', 'rev-parse', 'rev-list', 'cat-file', 'shortlog', 'describe', 'show-ref', 'for-each-ref', 'status', 'diff-tree', 'name-rev', 'merge-base']);

/** The sub-command of a `git` command line (past `-C dir` and `-c k=v`), or '' when there is none. */
export function gitSubcommand(args: string[]): string {
  let k = 0;
  while (k < args.length && args[k]!.startsWith('-')) {
    k += GIT_GLOBAL_VALUE_OPTIONS.has(args[k]!.split('=')[0]!) && !args[k]!.includes('=') ? 2 : 1;
  }
  return args[k] ?? '';
}

/** Does this command only read its operands (so a wildcard among them can be resolved and judged by what it matches)? */
export function readsOnly(words: string[], verbAt: number): boolean {
  if (verbAt === -1) {
    return false;
  }
  const verb = path.basename(words[verbAt]!).toLowerCase();
  if (!READ_ONLY_GLOB_VERBS.has(verb)) {
    return false;
  }
  const args = words.slice(verbAt + 1);
  if (verb === 'sed') {
    return !args.some((a) => a === '-i' || a === '--in-place' || /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place='));
  }
  if (verb === 'git') {
    return READ_ONLY_GIT.has(gitSubcommand(args));
  }
  return true;
}

/**
 * Why a shell command reads, copies, sources, redirects from or otherwise names a secret by the built-in classes and by the
 * configured patterns (`scope.patterns`); null when it does not. Every word of every simple command is judged as a path (so
 * `cat`, `less`, `head`, `grep`, `sed`, `awk`, `xxd`, `base64`, `cp`, `scp`, `rsync`, `tar`, `zip`, `source`, `. file`, `< file`,
 * `$(cat file)`, `curl -d @file` and a pipe out of any of them are all seen without a list of verbs), with `cd` followed so
 * `cd ~/.ssh && cat id_rsa` is judged where `id_rsa` really is. A directory walker (`grep -r`, `find`, `tar`, ...) pointed at `~`
 * or `~/.config` is held too, since it reaches the secrets below. Plain words such as `token` or `src/` are not paths to a secret,
 * so `grep -r "token" src/` stays allowed.
 *
 * What is not a path is not judged as one: the program of `awk` or `sed`, a `grep` or `rg` pattern, a `jq` filter, the code of
 * `node -e` or `python -c` (`patternWordIndexes`). And a wildcard that the shell expands in a
 * command that only reads (`cat internal/ws/*`) is resolved against the file system when `scope.list` is given: it is held
 * when a file it really matches is a secret, and by its shape (`.*`, `id_*`, `*.pem` can match one) when it cannot be resolved or matches nothing.
 */
// Consumed by the guard classifier for Bash calls, and by the tests.
export function bashSecretLabel(command: string, scope: SecretScope): string | null {
  if (command.length > MAX_COMMAND_LENGTH) {
    return 'a command too long to judge';
  }
  let cwd = scope.cwd;
  let judged = 0;
  for (const simple of shellCommands(command)) {
    const { words } = simple;
    const verbAt = verbIndex(words);
    const verb = verbAt === -1 ? '' : path.basename(words[verbAt]!);
    const here: SecretScope = { home: scope.home, cwd, ...(scope.list ? { list: scope.list } : {}), ...(scope.patterns ? { patterns: scope.patterns } : {}), ...(scope.real ? { real: scope.real } : {}) };
    const reads = readsOnly(words, verbAt);
    for (const [k, word] of words.entries()) {
      judged += 1;
      if (judged > MAX_WORDS) {
        return 'a command too long to judge';
      }
      if (simple.literal.has(k)) {
        continue;
      }
      // A word that was read again as a command is judged by its parts, which carry the configured patterns; as a whole it gets the built-in classes only.
      const wordScope: SecretScope = simple.expanded.has(k) ? { home: here.home, cwd: here.cwd, ...(here.list ? { list: here.list } : {}) } : here;
      if (reads && here.list && k > verbAt && !simple.quoted[k] && !word.startsWith('-') && isGlobWord(word)) {
        const matches = globMatches(word, here);
        // A wildcard that matches nothing is judged by its shape like one that cannot be resolved: a file may appear before the command runs.
        if (matches && matches.length > 0) {
          for (const match of matches) {
            // The match, and where it leads when it is a link.
            for (const form of new Set([match, here.real ? here.real(match) : match])) {
              const label = secretPathLabel(form, here, { wildcard: false });
              if (label) {
                return label;
              }
            }
          }
          continue;
        }
      }
      for (const candidate of pathCandidates(word)) {
        const label = secretPathLabel(candidate, wordScope);
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

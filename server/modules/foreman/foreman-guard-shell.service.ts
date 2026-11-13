import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { awkFacts, sedFacts, stringLiterals } from '@/modules/foreman/foreman-guard-programs.service.js'
import { bashSecretLabel, expandHome, gitSubcommand, globMatches, isGlobWord, MAX_GLOB_MATCHES, pathCandidates, patternWordIndexes, READ_ONLY_GIT, readsOnly, secretPathLabel, type DirLister, type SecretScope } from '@/modules/foreman/foreman-guard-secrets.service.js'

/**
 * A structural reader for shell commands (red-team hardening). The regular expressions in config see text; this reads the
 * command the way a shell would: quotes and escapes removed, `;` `&&` `||` `|` split, `bash -c`, `eval`, `$(...)` and
 * heredocs read again as commands of their own, `VAR=value` followed, `sudo`/`env`/`xargs`/`time` seen through, git global
 * options skipped, and a script the command is about to run (`bash run.sh`, `./go.sh`, `python x.py`, `npm run release`,
 * `make ship`) read from disk and judged as if its lines had been typed. It answers one question: must a person approve
 * this command? It errs towards yes. It is a heuristic over what the command SAYS, not a sandbox: a program that
 * builds its commands at run time (a compiled binary, an obfuscated script) is outside what it can see.
 *
 * The same file lives in cloudcli (`foreman-guard-shell.service.ts`); the red-team case table runs against both.
 */

export type ShellVerdict = { risky: false } | { risky: true; category: 'command' | 'secret' | 'outside_repo'; matched: string }

/** Disk access, injectable so tests need no real files. */
export interface ShellFs {
  read(file: string): string | null
  realpath(file: string): string
  /** Lists a directory (see `DirLister`). Absent: a wildcard is judged by its shape, never by what it matches. */
  list?: DirLister
  /** Runs a read-only lister (`find`, `ls`, `git ls-files`) so a command substitution can be judged by the paths it prints. Absent: such a substitution cannot be judged. */
  run?(argv: string[], cwd: string, timeoutMs: number, maxBytes: number): { stdout: string; status: number } | null
}

const isDirectoryLink = (file: string): boolean => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

export const nodeShellFs: ShellFs = {
  read(file) {
    try {
      if (!statSync(file).isFile() || statSync(file).size > 400_000) return null
      const text = readFileSync(file, 'utf8')
      return text.includes('\u0000') ? null : text
    } catch {
      return null
    }
  },
  realpath: resolveReal,
  list(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      if (entries.length > 20_000) return null
      return entries.map(e => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDirectoryLink(path.join(dir, e.name))) }))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? [] : null
    }
  },
  run(argv, cwd, timeoutMs, maxBytes) {
    try {
      const r = spawnSync(argv[0]!, argv.slice(1), {
        cwd,
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      })
      if (r.error || r.signal || r.status === null) return null
      return { stdout: r.stdout, status: r.status }
    } catch {
      return null
    }
  },
}

/** The real path of the longest existing prefix of `file`, with the rest put back: the target of a write that has not happened yet. */
export function resolveReal(file: string): string {
  let current = path.resolve(file)
  const rest: string[] = []
  for (let guard = 0; guard < 64; guard += 1) {
    if (existsSync(current)) {
      try {
        return path.join(realpathSync(current), ...rest.reverse())
      } catch {
        return path.resolve(file)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    rest.push(path.basename(current))
    current = parent
  }
  return path.resolve(file)
}

export interface ShellScope extends SecretScope {
  /** The session's repository: writes outside it are held. */
  repoRoot: string
  fs?: ShellFs
  /** Other repositories the session may read and never write (`guard.referenceDirs`): every write into one is held, whatever else allows it. */
  referenceDirs?: string[]
  /** Directories where plain files may be written (the task's scratch directory, /tmp): inline code may name paths there. */
  scratchDirs?: string[]
}

const label = (matched: string, category: 'command' | 'secret' | 'outside_repo' = 'command'): ShellVerdict => ({ risky: true, category, matched })

// ------------------------------------------------------------------------------------------------ parsing

interface Cmd {
  words: string[]
  /** Words that hold a substitution the reader could not resolve: `$(...)`, backticks. */
  dynamic: boolean[]
  /** For each word, the indexes (into the `subs` of `parse`) of the substitutions it holds. */
  subIdx?: number[][]
  redirects: Array<{ op: string; target: string }>
  pipeIn: boolean
  /** What came before this command: `start`, `;`, `&&`, `||`, `|`, `|&`, `&` or a newline. */
  sepBefore: string
  /** What ended this command: `;`, `&&`, `||`, `|`, `|&`, `&` (background) or a newline. */
  sepAfter: string
  heredoc?: string
}

const MAX_COMMAND = 100_000
const MAX_DEPTH = 4
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'in', 'select', 'function', '{', '}', '!', 'time', 'coproc'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|[abefnrtv\\'"?])/g, (_m, g: string) => {
    if (g[0] === 'x' || g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16))
    if (/^[0-7]/.test(g)) return String.fromCharCode(parseInt(g, 8))
    return ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' } as Record<string, string>)[g] ?? g
  })
}

/** Index of the `)` that closes the `(` at `open` (quotes and nesting respected), or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!
    if (quote) {
      if (c === '\\' && quote === '"') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') i += 1
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Splits one command text into simple commands. Substitutions (`$(...)`, backticks, `<(...)`) come back in `subs` to be read as commands of their own. */
function parse(input: string, vars: Map<string, string>, subs: string[]): Cmd[] {
  const cmds: Cmd[] = []
  let words: string[] = []
  let dyn: boolean[] = []
  let wsubs: number[][] = []
  let curSubs: number[] = []
  let redirects: Cmd['redirects'] = []
  let word = ''
  let inWord = false
  let wordDynamic = false
  let pipeIn = false
  let nextPipe = false
  let curSep = 'start'
  let pendingRedirect: string | null = null
  const heredocs: Array<{ delim: string; strip: boolean; cmd: number }> = []
  const bodies = new Map<number, string>()

  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, target: word })
      pendingRedirect = null
    } else {
      words.push(word)
      dyn.push(wordDynamic)
      wsubs.push(curSubs)
    }
    word = ''
    inWord = false
    wordDynamic = false
    curSubs = []
  }
  const endCmd = (pipe: boolean, sep = ';') => {
    endWord()
    if (words.length > 0 || redirects.length > 0) {
      // A lone `VAR=value` is an assignment of the shell: remember it so a later `$VAR` is read as its value.
      if (words.length > 0 && words.every(w => ASSIGN.test(w))) {
        for (const w of words) vars.set(w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1))
      }
      cmds.push({ words, dynamic: dyn, subIdx: wsubs, redirects, pipeIn, sepBefore: curSep, sepAfter: sep, ...(bodies.has(cmds.length) ? { heredoc: bodies.get(cmds.length) } : {}) })
    }
    curSep = words.length > 0 || redirects.length > 0 ? sep : curSep
    pipeIn = nextPipe
    words = []
    dyn = []
    wsubs = []
    redirects = []
    nextPipe = pipe
    pendingRedirect = null
  }
  const expandVar = (name: string): string | null => {
    if (vars.has(name)) return vars.get(name)!
    return null
  }

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!
    if (c === '\\') {
      if (i + 1 < input.length && input[i + 1] !== '\n') {
        word += input[i + 1]
        inWord = true
      }
      i += 1
      continue
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      const stop = end === -1 ? input.length : end
      word += input.slice(i + 1, stop)
      inWord = true
      i = stop
      continue
    }
    if (c === '"') {
      inWord = true
      let j = i + 1
      for (; j < input.length && input[j] !== '"'; j += 1) {
        const d = input[j]!
        if (d === '\\' && j + 1 < input.length) {
          word += '"\\$`'.includes(input[j + 1]!) ? input[j + 1] : `\\${input[j + 1]}`
          j += 1
        } else if (d === '$' && input[j + 1] === '(') {
          const end = closeParen(input, j + 1)
          const stop = end === -1 ? input.length : end
          subs.push(input.slice(j + 2, stop))
          curSubs.push(subs.length - 1)
          word += '\u0001'
          wordDynamic = true
          j = stop
        } else if (d === '`') {
          const end = input.indexOf('`', j + 1)
          const stop = end === -1 ? input.length : end
          subs.push(input.slice(j + 1, stop))
          curSubs.push(subs.length - 1)
          word += '\u0001'
          wordDynamic = true
          j = stop
        } else if (d === '$') {
          const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(input.slice(j))
          const value = m ? expandVar(m[1]!) : null
          if (m && value !== null) {
            word += value
            j += m[0].length - 1
          } else word += d
        } else word += d
      }
      i = j
      continue
    }
    if (c === '$' && input[i + 1] === "'") {
      const end = input.indexOf("'", i + 2)
      const stop = end === -1 ? input.length : end
      word += ansiC(input.slice(i + 2, stop))
      inWord = true
      i = stop
      continue
    }
    if (c === '$' && input[i + 1] === '(') {
      const end = closeParen(input, i + 1)
      const stop = end === -1 ? input.length : end
      subs.push(input.slice(i + 2, stop))
      curSubs.push(subs.length - 1)
      word += '\u0001'
      inWord = true
      wordDynamic = true
      i = stop
      continue
    }
    if (c === '`') {
      const end = input.indexOf('`', i + 1)
      const stop = end === -1 ? input.length : end
      subs.push(input.slice(i + 1, stop))
      curSubs.push(subs.length - 1)
      word += '\u0001'
      inWord = true
      wordDynamic = true
      i = stop
      continue
    }
    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      const end = closeParen(input, i + 1)
      const stop = end === -1 ? input.length : end
      subs.push(input.slice(i + 2, stop))
      word += '/dev/fd/63'
      inWord = true
      i = stop
      continue
    }
    if (c === '$') {
      const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(input.slice(i))
      if (m) {
        const value = expandVar(m[1]!)
        if (value !== null) {
          word += value
          inWord = true
          i += m[0].length - 1
          continue
        }
      }
      word += c
      inWord = true
      continue
    }
    if (c === '#' && !inWord) {
      // A comment runs to the end of the line.
      while (i < input.length && input[i] !== '\n') i += 1
      i -= 1
      continue
    }
    if (c === '\n') {
      endCmd(false, '\n')
      // A heredoc body starts on the line after the command that opened it.
      while (heredocs.length > 0) {
        const h = heredocs.shift()!
        const lines: string[] = []
        let at = i + 1
        while (at <= input.length) {
          const eol = input.indexOf('\n', at)
          const line = input.slice(at, eol === -1 ? input.length : eol)
          at = eol === -1 ? input.length + 1 : eol + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          lines.push(line)
        }
        bodies.set(h.cmd, lines.join('\n'))
        // Re-attach the body to the command it belongs to (already pushed).
        const target = cmds[h.cmd]
        if (target) target.heredoc = lines.join('\n')
        i = at - 2
      }
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      endCmd(false, ';')
      continue
    }
    if (c === '&') {
      if (input[i + 1] === '>') {
        endWord()
        pendingRedirect = '&>'
        i += input[i + 2] === '>' ? 2 : 1
        continue
      }
      if (input[i + 1] === '&') {
        endCmd(false, '&&')
        i += 1
      } else endCmd(false, '&')
      continue
    }
    if (c === '|') {
      if (input[i + 1] === '|') {
        endCmd(false, '||')
        i += 1
      } else if (input[i + 1] === '&') {
        endCmd(true, '|&')
        i += 1
      } else endCmd(true, '|')
      continue
    }
    if (c === '<' || c === '>') {
      // `2>&1`, `>&2`: a descriptor copy, not a file.
      const dupe = /^[<>]&[0-9-]/.test(input.slice(i, i + 3))
      if (inWord && /^[0-9]+$/.test(word) && !wordDynamic) {
        word = ''
        inWord = false
      } else endWord()
      if (dupe) {
        i += 2
        while (/[0-9-]/.test(input[i + 1] ?? '')) i += 1
        continue
      }
      let op = c
      while (input[i + 1] === c && op.length < 3) {
        op += c
        i += 1
      }
      if (c === '>' && (input[i + 1] === '|' || input[i + 1] === '&')) i += 1
      if (op === '<<') {
        const m = /^\s*(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(input.slice(i + 1))
        if (m) {
          heredocs.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', strip: m[1] === '-', cmd: cmds.length })
          i += m[0].length
        }
        continue
      }
      pendingRedirect = op
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    word += c
    inWord = true
  }
  endCmd(false)
  return cmds
}

/** The simple commands of a shell command text, with what separates them (`&&`, `||`, `;`, `|`, `&`). Used by the evidence check to see how a gate command was really run. */
export function shellSegments(command: string): Array<{ words: string[]; redirects: Array<{ op: string; target: string }>; sepBefore: string; sepAfter: string; pipeIn: boolean }> {
  return parse(command, new Map(), []).map(c => ({ words: c.words, redirects: c.redirects, sepBefore: c.sepBefore, sepAfter: c.sepAfter, pipeIn: c.pipeIn }))
}

// ------------------------------------------------------------------------------------------------ classification

interface Ctx {
  scope: ShellScope
  fs: ShellFs
  cwd: string
  vars: Map<string, string>
  depth: number
  /** Files this command text writes, with their content when it is known (`cat > f <<EOF`, `echo ... > f`). */
  written: Map<string, string | null>
  budget: { left: number }
  /** The substitutions of the command text being judged (`parse`'s `subs`). */
  subs: string[]
  /** What the whole call may still spend on running read-only listers (`find`, `ls`, `git ls-files`) to see what a substitution names. */
  listers: { left: number; until: number }
}

const base = (word: string): string => path.basename(word).toLowerCase()

const GIT_KNOWN = new Set(
  ('add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick clean clone commit config count-objects describe diff diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base mergetool mv name-rev notes pull push range-diff rebase reflog remote repack replace request-pull reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch tag update-index update-ref verify-commit version whatchanged worktree filter-branch filter-repo prune send-pack bugreport diagnose maintenance').split(' '),
)
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const GIT_RISKY_CONFIG = /^(alias\.|core\.(hookspath|fsmonitor|sshcommand|pager|gitproxy|askpass)|credential\.|url\.|remote\.|include|filter\.|protocol\.|http\.[^=]*proxy|diff\.[^=]*\.(textconv|command)|merge\.[^=]*\.driver)/i

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'cp', 'mv', 'tar', 'zip', 'source', '.', 'awk', 'sed', 'cut', 'sort', 'uniq', 'diff', 'md5sum', 'sha1sum', 'sha256sum', 'openssl', 'gpg', 'jq', 'yq', 'curl', 'wget', 'scp', 'rsync', 'grep', 'egrep', 'fgrep', 'rg', 'ag'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox'])
const INTERP = /^(python[0-9.]*|node(js)?[0-9.]*|deno|bun|ruby[0-9.]*|perl[0-9.]*|php[0-9.]*|tsx|ts-node|lua[0-9.]*|rscript|pwsh|powershell|osascript)$/
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'watch', 'setsid', 'unbuffer', 'chronic', 'caffeinate', 'flock', 'strace', 'ltrace', 'gtimeout'])
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec', 'runuser', 'machinectl'])

const INLINE_DANGER = [
  /\b(os\.(system|popen|exec\w*|remove|unlink|rmdir|removedirs)|subprocess|shutil\.rmtree|child_process|execSync|execFileSync|spawnSync|spawn\(|Deno\.(run|Command)|Runtime\.getRuntime|system\(|passthru\(|shell_exec|proc_open|popen\()/,
  /(\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync)\s*\(|\brimraf\b|File\.(delete|write)|FileUtils\.rm)/,
  /\b(requests\.(post|put|delete|patch)|urllib|http\.client|httpx|socket\b|net\.connect|axios\.(post|put|delete)|XMLHttpRequest|fetch\s*\([^)]*(POST|PUT|DELETE|PATCH|body)|WebSocket|smtplib|ftplib|paramiko)/,
  /(JSON\.stringify\(\s*process\.env|Object\.(entries|keys|values)\(\s*process\.env|console\.log\(\s*process\.env\s*\)|dict\(\s*os\.environ|os\.environ\b(\.(items|copy|keys|values)|\s*\))|print\(\s*os\.environ|\bENV\.to_h|\$_ENV|getenv\(\s*\))/,
  /\b(git\s+(-\S+\s+)*push|npm\s+publish|rm\s+-[a-z]*[rf]|DROP\s+(TABLE|DATABASE)|curl\s+[^|;]*(-d|--data|-F|-T)\b)/i,
  /\b(eval|exec)\s*\(\s*(base64|atob|Buffer\.from|b64decode|codecs\.decode|zlib|decode)/i,
  /(__import__|\bimportlib\b|\bcompile\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\beval\s*\(|\bexec\s*\(|\batob\s*\(|\bb64decode\b|\bbase64\b)/,
  /(process\.env|os\.environ|\bENV\b|getenv|System\.getenv)\W[^;\n]{0,40}(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH)/i,
]

// Inline code that only reads is code with none of: a write, a delete, a process, the network. These add the forms the list above does not name.
INLINE_DANGER.push(
  /\.(mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|utimes|utimesSync|openSync|writeSync|createWriteStream|write_text|write_bytes|touch|kill)\s*\(/,
  /\b(require|import)\s*\(?\s*['"`](node:)?(https?|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)['"`]|\bfrom\s+['"`](node:)?(https?|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)['"`]/,
  /\bfetch\s*\(/,
  /\b(import|from)\s+(requests|aiohttp|http|socket|subprocess|urllib\d?|ftplib|smtplib|telnetlib|websockets?)\b/,
  /\bopen\s*\([^)]*,\s*['"]\s*[wax+][bt+]?\s*['"]/,
)

const SQL_DANGER = /\b(DROP\s+\w+|TRUNCATE\b|DELETE\s+FROM\b|ALTER\s+(TABLE|DATABASE|ROLE|USER|SYSTEM)\b[^;]*\b(DROP|RENAME|OWNER)|GRANT\b|REVOKE\b|FLUSH(ALL|DB)\b|dropDatabase|\.drop\(\)|deleteMany\(\s*\{\s*\}\s*\)|UPDATE\s+\S+\s+SET\b(?![^;]*\bWHERE\b))/i
const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWD|PASSWORD|PASS|CREDENTIAL|AUTH|PRIVATE|COOKIE)[A-Za-z0-9_]*\}?/
const SECRET_NAME = /key|token|secret|pass|credential|auth|private|cookie|session/i

const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'mongosh', 'mongo', 'redis-cli', 'cqlsh', 'clickhouse-client', 'duckdb', 'pgcli', 'usql', 'sqlcmd', 'mycli', 'litecli'])
const NETWORK_TOOLS = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'tftp', 'rclone', 's3cmd', 'mc', 'sshpass', 'mosh', 'ngrok', 'cloudflared', 'localtunnel', 'lt'])
const SYSTEM_TOOLS = new Set(['reboot', 'shutdown', 'halt', 'poweroff', 'init', 'telinit', 'crontab', 'at', 'batch', 'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod', 'passwd', 'chpasswd', 'visudo', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'modprobe', 'insmod', 'rmmod', 'losetup', 'shred', 'wipefs', 'dd', 'fdisk', 'parted', 'mkswap', 'swapoff', 'swapon', 'kill', 'pkill', 'killall', 'skill', 'snice', 'setcap', 'chattr', 'sysctl', 'umount'])
const PKG_SYSTEM = new Set(['apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'pacman', 'zypper', 'apk', 'snap', 'flatpak'])
const PM_PUBLISH = new Set(['publish', 'unpublish', 'deprecate', 'login', 'logout', 'adduser', 'token', 'owner', 'access', 'dist-tag', 'team', 'org', 'profile', 'whoami-token'])
const NPM_BUILTIN = new Set(
  ('install i add remove rm uninstall un update up upgrade ci audit outdated list ls ll la why pack init create exec dlx x link ln unlink prune dedupe rebuild root bin prefix view info show search help cache doctor fund explain completion env workspaces workspace store patch import licenses approve-builds self-update ping whoami bugs docs home repo pkg query sbom diff find-dupes install-test it cit install-ci-test config c set-script version stage hook dlx up fetch').split(' '),
)

/** `-abc`, `--name` and positionals of an argument list. `--` ends options. */
function options(args: string[]): { short: Set<string>; long: Set<string>; pos: string[] } {
  const short = new Set<string>()
  const long = new Set<string>()
  const pos: string[] = []
  let done = false
  for (const a of args) {
    if (done) pos.push(a)
    else if (a === '--') done = true
    else if (a.startsWith('--')) long.add(a.split('=')[0]!.toLowerCase())
    else if (/^-[A-Za-z]/.test(a)) for (const l of a.slice(1)) short.add(l)
    else pos.push(a)
  }
  return { short, long, pos }
}

const insideRepo = (target: string, ctx: Ctx): boolean => {
  const root = ctx.fs.realpath(ctx.scope.repoRoot)
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}
const SCRATCH = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', tmpdir()]
const isScratch = (target: string): boolean => SCRATCH.some(d => target === d || target.startsWith(d + path.sep)) || /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/.test(target)

/** The path a word names, resolved the way the CLI would: `~` and `$HOME` expanded, relative to the working directory, links followed. */
const resolveWord = (word: string, ctx: Ctx): string => ctx.fs.realpath(path.resolve(ctx.cwd, expandHome(word, ctx.scope.home)))

/** Why writing to `word` must be approved, or null. The repo is writable, scratch space is writable, `.git/hooks` and project settings are not. */
export function writeTargetLabel(target: string, repoRoot: string, home: string, fsx: ShellFs = nodeShellFs, cwd = repoRoot, referenceDirs: readonly string[] = []): string | null {
  const written = path.resolve(cwd, expandHome(target, home))
  // The standard streams are links into /proc (or a pty): writing to them leaves nothing behind.
  if (/^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/.test(written)) return null
  const abs = fsx.realpath(written)
  // A reference repository is read-only, whatever else would allow the write (the repository root being `/`, a scratch directory above it).
  for (const dir of referenceDirs) {
    const ref = fsx.realpath(dir)
    if (abs === ref || abs.startsWith(ref.endsWith(path.sep) ? ref : ref + path.sep)) return `a write into a reference directory (${dir}), which is read-only`
  }
  const root = fsx.realpath(repoRoot)
  const inside = abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  if (inside) {
    const rel = path.relative(root, abs)
    if (/(^|\/)(node_modules|\.venv|venv|site-packages)(\/|$)/.test(rel)) return `an installed dependency (${rel}): patching it can make any check pass`
    if (/^\.git\/(hooks|config|info\/attributes|modules)(\/|$)/.test(rel) || /^\.claude(\/|$)/.test(rel) || rel === '.mcp.json' || /^\.git\/.*\bpackedglobs?$/.test(rel)) return `a protected file of the repository (${rel})`
    return null
  }
  if (isScratch(abs)) return null
  return `a write outside the repository (${abs})`
}

function readScript(file: string, ctx: Ctx): string | null {
  const abs = resolveWord(file, ctx)
  const known = ctx.written.get(abs)
  if (known !== undefined && known !== null) return known
  return ctx.fs.read(abs)
}

/** Shell judged recursively: the script text of `bash -c`, `eval`, a file about to run. */
function nested(text: string, ctx: Ctx, why: string): ShellVerdict {
  if (ctx.depth >= MAX_DEPTH || ctx.budget.left <= 0) return label('a command nested too deep to judge')
  ctx.budget.left -= 1
  const reads = bashSecretLabel(text, { home: ctx.scope.home, cwd: ctx.cwd, ...(ctx.fs.list ? { list: ctx.fs.list } : {}), real: ctx.fs.realpath })
  if (reads) return label(`${why}: ${reads}`, 'secret')
  const v = judge(text, { ...ctx, depth: ctx.depth + 1, vars: new Map(ctx.vars) })
  return v.risky ? { ...v, matched: `${why}: ${v.matched}` } : v
}

function scriptDanger(text: string): string | null {
  for (const re of INLINE_DANGER) if (re.test(text)) return 'code that runs commands, deletes or writes files, uses the network or reads the environment'
  return null
}

function makeTargets(c: Cmd, verb: string, args: string[]): string[] {
  const o = options(args)
  const pos = o.pos
  switch (verb) {
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = args.findIndex(a => a === '-t' || a === '--target-directory')
      if (t >= 0 && args[t + 1]) return [args[t + 1]!]
      const long = args.find(a => a.startsWith('--target-directory='))
      if (long) return [long.split('=')[1]!]
      return pos.length >= 2 ? [pos[pos.length - 1]!] : []
    }
    case 'tee':
    case 'touch':
    case 'mkdir':
    case 'rmdir':
    case 'truncate':
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return verb === 'chmod' || verb === 'chown' || verb === 'chgrp' ? pos.slice(1) : pos
    case 'sed':
      return o.short.has('i') || o.long.has('--in-place') ? (args.some(a => a === '-e' || a === '-f') ? pos : pos.slice(1)) : []
    case 'dd':
      return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
    case 'curl':
      return args.flatMap((a, i) => (a === '-o' || a === '--output' ? [args[i + 1] ?? ''] : a.startsWith('--output=') ? [a.slice(9)] : a.startsWith('-o') && a.length > 2 ? [a.slice(2)] : []))
    case 'wget':
      return args.flatMap((a, i) => (a === '-O' || a === '-P' || a === '--output-document' || a === '--directory-prefix' ? [args[i + 1] ?? ''] : a.startsWith('-O') && a.length > 2 ? [a.slice(2)] : a.startsWith('--output-document=') ? [a.slice(18)] : []))
    case 'tar':
      return args.flatMap((a, i) => (a === '-C' || a === '--directory' ? [args[i + 1] ?? ''] : a.startsWith('--directory=') ? [a.slice(12)] : []))
    case 'unzip':
      return args.flatMap((a, i) => (a === '-d' ? [args[i + 1] ?? ''] : []))
    default:
      return c.redirects.length ? [] : []
  }
}

// ------------------------------------------------------------------------------------------------ programs, listers, reference directories

const inside = (target: string, dir: string, fsx: ShellFs): boolean => {
  const root = fsx.realpath(dir)
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}
const inReferenceDir = (target: string, ctx: Ctx): boolean => (ctx.scope.referenceDirs ?? []).some(dir => inside(ctx.fs.realpath(target), dir, ctx.fs))

/** Where inline code may name a path without a person: the repository, a reference directory, the scratch directories and /tmp. Null when `literal` is not a path outside them. */
function outsideRootsLabel(literal: string, ctx: Ctx): string | null {
  if (ctx.scope.repoRoot === '/' || /\s/.test(literal)) return null
  let abs: string
  if (/^~(\/|$)/.test(literal) || /^\$\{?HOME\}?(\/|$)/.test(literal)) abs = expandHome(literal, ctx.scope.home)
  else if (/^\/[^\s/]/.test(literal)) abs = literal
  else if (/(^|\/)\.\.(\/|$)/.test(literal)) abs = path.resolve(ctx.cwd, literal)
  else return null
  abs = ctx.fs.realpath(abs)
  if (isScratch(abs) || [ctx.scope.repoRoot, ...(ctx.scope.referenceDirs ?? []), ...(ctx.scope.scratchDirs ?? [])].some(dir => inside(abs, dir, ctx.fs))) return null
  return `a path outside the repository named in inline code (${abs})`
}

/** Why a path named inside a program (an awk `getline < file`, a sed `r file`, a string of inline code) must be approved: a secret by the built-in classes or the configured patterns. */
function literalSecretLabel(literal: string, ctx: Ctx): string | null {
  if (!literal || literal.length > 4096) return null
  return secretPathLabel(literal, { home: ctx.scope.home, cwd: ctx.cwd, ...(ctx.scope.patterns ? { patterns: ctx.scope.patterns } : {}) }, { wildcard: false })
}

/**
 * Inline code (`node -e`, `python -c`, ...): its text is code, not a path, so nothing in it is matched as one (`x.key` is a property). What
 * it names as a string is: a secret path, or a path outside the places a worker may read freely.
 */
function codeLiteralVerdict(code: string, ctx: Ctx): ShellVerdict | null {
  for (const literal of stringLiterals(code)) {
    // A string may hold a file name next to an open mode or a flag (`"<.env"`, `"cat .env"`): its pieces are judged as well.
    for (const piece of new Set([literal, ...literal.split(/[\s<>|&;,=:()]+/)])) {
      const secret = literalSecretLabel(piece, ctx)
      if (secret) return label(secret, 'secret')
    }
    const outside = outsideRootsLabel(literal, ctx)
    if (outside) return label(outside, 'secret')
  }
  return null
}

function judgeAwk(c: Cmd, verb: string, args: string[], ctx: Ctx): ShellVerdict | null {
  const programs = [...patternWordIndexes(c.words)].map(k => c.words[k]!)
  if (programs.length === 0) {
    // The program comes from a file (`-f`): all that can be judged is the command line.
    const danger = scriptDanger(args.join(' '))
    return danger ? label(`${verb} program: ${danger}`) : null
  }
  // gawk's `-i inplace` rewrites the files it is given: they are written.
  const inPlace = args.some((a, k) => (/^(-i|--include)$/.test(a) && /inplace/.test(args[k + 1] ?? '')) || /^(-i|--include=)\s*\S*inplace/.test(a))
  if (inPlace) {
    const skip = new Set(patternWordIndexes(c.words))
    for (const [k, word] of c.words.entries()) {
      if (k === 0 || skip.has(k) || word.startsWith('-') || /inplace/.test(word) && /^(-i|--include)$/.test(c.words[k - 1] ?? '') || /^(-F|-v|-l|-W)$/.test(c.words[k - 1] ?? '')) continue
      const out = writeTargetLabel(word, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
      if (out) return label(`${verb} -i inplace: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
    }
  }
  for (const program of programs) {
    const f = awkFacts(program)
    if (f.system) return label(`${verb} program runs a command (system)`)
    if (f.pipe) return label(`${verb} program pipes to or from a command`)
    if (f.environ) return label(`${verb} program reads the environment (ENVIRON)`)
    if (f.include) return label(`${verb} program loads code from another file`)
    for (const r of f.redirects) {
      if (r.target === null) {
        if (inReferenceDir(ctx.cwd, ctx)) return label(`${verb} program writes a file named at run time inside a reference directory`)
        continue
      }
      const secret = literalSecretLabel(r.target, ctx)
      if (secret) return label(secret, 'secret')
      const out = writeTargetLabel(r.target, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
      if (out) return label(`${verb} program: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
    }
    for (const file of f.reads) {
      const secret = file === null ? null : literalSecretLabel(file, ctx)
      if (secret) return label(secret, 'secret')
    }
  }
  return null
}

function judgeSed(c: Cmd, ctx: Ctx): ShellVerdict | null {
  for (const k of patternWordIndexes(c.words)) {
    const text = c.words[k]!.replace(/^--expression=/, '')
    const f = sedFacts(text)
    if (!f.parsed) {
      // A script this reader does not understand is judged as plain text, as it always was.
      const secret = bashSecretLabel(text, { home: ctx.scope.home, cwd: ctx.cwd, ...(ctx.scope.patterns ? { patterns: ctx.scope.patterns } : {}) })
      if (secret) return label(secret, 'secret')
      continue
    }
    if (f.exec) return label('sed runs a command (e)')
    for (const file of f.writes) {
      const secret = literalSecretLabel(file, ctx)
      if (secret) return label(secret, 'secret')
      const out = writeTargetLabel(file, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
      if (out) return label(`sed: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
    }
    for (const file of f.reads) {
      const secret = literalSecretLabel(file, ctx)
      if (secret) return label(secret, 'secret')
    }
  }
  return null
}

const LISTER_MS = 3000
const LISTER_BYTES = 1_000_000
const FIND_FORBIDDEN = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'])
const GIT_LS_FLAGS = new Set(['-c', '-o', '-m', '-d', '-s', '-z', '-t', '-v', '-k', '-u', '-i', '-co', '-oc', '--cached', '--others', '--deleted', '--modified', '--stage', '--exclude-standard', '--full-name', '--error-unmatch', '--directory', '--no-empty-directory', '--deduplicate', '--eol', '--unmerged', '--killed', '--ignored'])
const WILDCARD = /[*?[]/

/** The command line of a substitution that only lists paths (`find` without anything that deletes, runs or writes; `ls`; `git ls-files`), or null for anything else. */
function listerArgv(words: string[]): string[] | null {
  if (words.length === 0 || ASSIGN.test(words[0]!) || words.some(w => /[$\u0001]/.test(w))) return null
  const verb = path.basename(words[0]!)
  const args = words.slice(1)
  if (verb === 'find') {
    if (args.some(a => FIND_FORBIDDEN.has(a))) return null
    // Start points come before the first predicate; a wildcard in one would be expanded by the shell, which this does not do.
    let at = 0
    while (at < args.length && (['-H', '-L', '-P'].includes(args[at]!) || /^-O\d?$/.test(args[at]!))) at += 1
    const starts: string[] = []
    while (at < args.length && !/^(-|\(|!)/.test(args[at]!)) starts.push(args[at++]!)
    if (starts.some(a => WILDCARD.test(a))) return null
    return ['find', ...args]
  }
  if (verb === 'ls') return args.some(a => WILDCARD.test(a)) ? null : ['ls', ...args]
  if (verb === 'git' && args[0] === 'ls-files') {
    const rest = args.slice(1)
    if (rest.some(a => a !== '--' && a.startsWith('-') && !GIT_LS_FLAGS.has(a))) return null
    return ['git', '-c', 'core.fsmonitor=false', 'ls-files', ...rest]
  }
  return null
}

/** A filter that can only drop or reorder lines, so what it lets through is part of what the lister printed. */
function safeFilter(words: string[]): boolean {
  const verb = path.basename(words[0] ?? '')
  const args = words.slice(1)
  if (verb === 'sort' || verb === 'uniq') return args.every(a => /^-[unrfbdisc]+$/.test(a))
  if (verb !== 'head' && verb !== 'tail') return false
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!
    if (/^-\d+$/.test(a)) continue
    if ((a === '-n' || a === '-c') && /^\d+$/.test(args[k + 1] ?? '')) k += 1
    else return false
  }
  return true
}

/**
 * The paths a command substitution prints, found by running it, when it is only a lister: one `find` (no -exec, -execdir, -ok, -okdir, -delete, -fprint*,
 * -fls), `ls` or `git ls-files`, optionally through `sort`, `uniq`, `head` or `tail`, with nothing but `/dev/null` as a redirect and nothing built at run
 * time inside. Run without a shell, for at most a few seconds and a megabyte, `ctx.listers` being what the whole call may spend. Null when the
 * substitution is anything else, did not finish, or printed too much: the caller holds the command, as it always did.
 */
function listedPaths(body: string, ctx: Ctx): string[] | null {
  const run = ctx.fs.run
  if (!run || ctx.listers.left <= 0) return null
  const inner: string[] = []
  const cmds = parse(body, new Map(ctx.vars), inner)
  if (inner.length > 0 || cmds.length < 1 || cmds.length > 3) return null
  for (const [n, c] of cmds.entries()) {
    if (c.heredoc !== undefined || c.dynamic.some(Boolean) || c.redirects.some(r => r.target !== '/dev/null')) return null
    if (n > 0 && !(c.pipeIn && c.sepBefore === '|')) return null
    if (n < cmds.length - 1 && c.sepAfter !== '|') return null
  }
  const argv = listerArgv(cmds[0]!.words)
  if (!argv || !cmds.slice(1).every(c => safeFilter(c.words))) return null
  const ms = Math.min(LISTER_MS, ctx.listers.until - Date.now())
  if (ms < 100) return null
  ctx.listers.left -= 1
  const res = run(argv, ctx.cwd, ms, LISTER_BYTES)
  if (!res || (argv[0] === 'git' ? res.status !== 0 : res.status > 2)) return null
  const out = new Set<string>()
  for (const line of res.stdout.includes('\0') ? res.stdout.split('\0') : res.stdout.split('\n')) {
    const text = line.replace(/\r$/, '')
    if (!text) continue
    out.add(text)
    // The shell splits an unquoted substitution at white space: each piece is a word of its own.
    for (const part of text.split(/\s+/)) if (part) out.add(part)
    if (out.size > MAX_GLOB_MATCHES) return null
  }
  return [...out]
}

/** One path a lister printed, judged as the word it becomes: a secret by the classes or patterns, itself, as an absolute path and where its links lead. Null when it cannot be judged. */
function judgeListedPath(listed: string, ctx: Ctx): ShellVerdict | null {
  const scope: SecretScope = { home: ctx.scope.home, cwd: ctx.cwd, ...(ctx.fs.list ? { list: ctx.fs.list } : {}), ...(ctx.scope.patterns ? { patterns: ctx.scope.patterns } : {}) }
  // A name with a wildcard in it is expanded again by the shell: what it then matches is read too.
  const paths = isGlobWord(listed) ? globMatches(listed, scope) : [listed]
  if (paths === null) return null
  for (const p of [listed, ...paths]) {
    const abs = path.resolve(ctx.cwd, expandHome(p, ctx.scope.home))
    for (const form of new Set([p, abs, ctx.fs.realpath(abs)])) {
      const secret = secretPathLabel(form, scope, { wildcard: false })
      if (secret) return label(secret, 'secret')
    }
  }
  return { risky: false }
}

/**
 * The paths that the command substitutions among the arguments of a command print, each found by running a plain lister (`listedPaths`).
 * Empty when there is no substitution among the arguments; null when one of them is not a plain lister or did not finish.
 */
function substitutionPaths(c: Cmd, verbAt: number, ctx: Ctx): string[] | null {
  const paths: string[] = []
  for (let k = verbAt + 1; k < c.words.length; k += 1) {
    if (c.dynamic[k] !== true) continue
    const indexes = c.subIdx?.[k] ?? []
    const body = indexes.length === 1 ? ctx.subs[indexes[0]!] : undefined
    if (c.words[k] !== '\u0001' || body === undefined) return null
    const listed = listedPaths(body, ctx)
    if (listed === null) return null
    paths.push(...listed)
  }
  return paths
}

/**
 * A reader (`awk`, `sed`, `grep`, `cat`, ...) whose path arguments come from command substitutions. When each one is a plain lister, running it shows
 * the files the reader will really be given, and they are judged like any other path. Null: something here cannot be judged, so the call is held.
 */
function judgeSubstitutedPaths(c: Cmd, verbAt: number, ctx: Ctx): ShellVerdict | null {
  const paths = substitutionPaths(c, verbAt, ctx)
  if (paths === null || paths.length === 0 && !c.dynamic.some(Boolean)) return null
  for (const p of paths) {
    const v = judgeListedPath(p, ctx)
    if (v === null) return null
    if (v.risky) return v
  }
  return { risky: false }
}

function judgeCmd(c: Cmd, ctx: Ctx): ShellVerdict {
  const words = c.words
  // ---- the verb: past assignments, reserved words and wrappers
  let i = 0
  let mass = false
  const assigned = new Map<string, string>()
  const next = (): string | undefined => words[i]
  for (; i < words.length; ) {
    const w = words[i]!
    if (ASSIGN.test(w)) {
      assigned.set(w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1))
      i += 1
    } else if (RESERVED.has(w)) i += 1
    else break
  }
  if (i >= words.length) {
    // Only assignments (and redirects): nothing runs, but a redirect can still write.
    return redirectVerdict(c, ctx)
  }
  const dynamicVerb = c.dynamic[i] === true || (words[i]!.includes('$') && !/^\$\{?HOME\}?/.test(words[i]!))
  let verb = base(words[i]!)
  if (dynamicVerb) return label('a command whose name is built at run time')
  if (/[{*?]/.test(words[i]!) || /^\[.*\]/.test(words[i]!) && words[i] !== '[' && words[i] !== '[[') return label('a command name built with a wildcard or brace expansion')
  const env = new Map(assigned)
  for (;;) {
    verb = base(next() ?? '')
    if (PRIVILEGE.has(verb)) return label(`${verb} (runs with other privileges)`)
    if (verb === 'env') {
      i += 1
      while (i < words.length && (words[i]!.startsWith('-') || ASSIGN.test(words[i]!))) {
        const o = words[i]!
        if (ASSIGN.test(o)) env.set(o.slice(0, o.indexOf('=')), o.slice(o.indexOf('=') + 1))
        // env -S "cmd args": the next word is a command line.
        if ((o === '-S' || o === '--split-string' || /^-[A-Za-z]*S$/.test(o)) && words[i + 1] !== undefined) return nested(words[i + 1]!, ctx, 'env -S')
        if (o.startsWith('--split-string=')) return nested(o.slice(15), ctx, 'env -S')
        // Options that take a value: the value is not the command.
        i += ['-u', '--unset', '-C', '--chdir', '-P'].includes(o) ? 2 : 1
      }
      if (i >= words.length) return label('env (prints every environment variable)')
      continue
    }
    if (verb === 'xargs') {
      mass = true
      i += 1
      while (i < words.length && words[i]!.startsWith('-')) {
        const o = words[i]!
        i += 1
        if (['-I', '-L', '-n', '-P', '-d', '-s', '-E', '-a'].includes(o)) i += 1
      }
      if (i >= words.length) return redirectVerdict(c, ctx)
      continue
    }
    if (WRAPPERS.has(verb)) {
      i += 1
      while (i < words.length && (words[i]!.startsWith('-') || /^\d+[smhd]?$/.test(words[i]!))) i += 1
      // flock LOCKFILE cmd: the lock file is not the command.
      if (verb === 'flock' && i < words.length) i += 1
      if (i >= words.length) return redirectVerdict(c, ctx)
      continue
    }
    break
  }
  const args = words.slice(i + 1)
  const dynArgs = c.dynamic.slice(i + 1)
  const raw = words[i]!
  const vi = (name: string) => env.get(name) ?? ctx.vars.get(name)

  // ---- redirections write files
  const red = redirectVerdict(c, ctx)
  if (red.risky) return red

  // ---- script indirection and shells
  if (SHELLS.has(verb) || verb === 'source' || verb === '.' || verb === 'eval' || INTERP.test(verb) || (raw.includes('/') && !raw.startsWith('-') && !['/bin/echo', '/usr/bin/env'].includes(raw))) {
    const v = judgeScriptRun(verb, raw, args, c, ctx, dynArgs)
    if (v) return v
  }

  switch (verb) {
    case 'rm': {
      const o = options(args)
      if (o.short.has('r') || o.short.has('R') || o.long.has('--recursive')) return label('rm -r (recursive delete)')
      if (o.long.has('--no-preserve-root')) return label('rm --no-preserve-root')
      if (mass) return label('xargs rm (deletes many files)')
      for (const p of o.pos) {
        if (/^(\.|\.\.|\*|\.\*|\.\/\*|~|\$HOME|\/)$/.test(p) || /\/\*$/.test(p)) return label(`rm of a whole directory (${p})`)
        const out = writeTargetLabel(p, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
        if (out) return label(`rm: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
      }
      return { risky: false }
    }
    case 'find': {
      const iDel = args.indexOf('-delete')
      if (iDel >= 0) return label('find -delete')
      for (let k = 0; k < args.length; k += 1) {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[k]!)) {
          const end = args.findIndex((a, j) => j > k && (a === ';' || a === '+' || a === '\\;'))
          const sub = args.slice(k + 1, end === -1 ? args.length : end)
          const inner = base(sub[0] ?? '')
          if (['rm', 'shred', 'unlink', 'mv', 'dd', 'truncate', 'chmod', 'chown', 'sh', 'bash'].includes(inner)) return label(`find -exec ${inner}`)
          const v = judgeCmd({ words: sub, dynamic: sub.map(() => false), redirects: [], pipeIn: false, sepBefore: ';', sepAfter: ';' }, ctx)
          if (v.risky) return v
        }
      }
      return { risky: false }
    }
    case 'git':
      return judgeGit(args, ctx)
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'npx':
    case 'pnpx':
    case 'bunx':
    case 'corepack':
      return judgePackageManager(verb, args, ctx)
    case 'make':
    case 'gmake':
      return judgeMake(args, ctx)
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const o = options(args)
      if (o.short.has('R') || o.long.has('--recursive')) return label(`${verb} -R (recursive permission change)`)
      const mode = o.pos[0] ?? ''
      if (verb === 'chmod' && (/^[0-7]?[0-7]{2}[2367]$/.test(mode) || /^0?[4-7][0-7]{3}$/.test(mode) || /(^|,)[ugoa]*[+=][rwx]*[ws]/.test(mode) && !/^u[+=]x$/.test(mode))) return label('chmod to a world-writable or setuid mode')
      break
    }
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
    case 'aria2c': {
      const o = options(args)
      const flags = [...o.long, ...[...o.short].map(s => `-${s}`)]
      const upload = flags.some(f => ['-d', '-F', '-T', '--data', '--data-binary', '--data-raw', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string', '--upload-file', '--post-data', '--post-file', '--body-data', '--body-file', '--post301', '--post302', '--post303'].includes(f))
      if (upload) return label(`${verb} sending data`)
      const method = args.findIndex(a => a === '-X' || a === '--request' || a === '--method' || a.startsWith('--method=') || a.startsWith('--request='))
      if (method >= 0) {
        const m = (args[method]!.includes('=') ? args[method]!.split('=')[1]! : args[method + 1] ?? '').toUpperCase()
        if (m && m !== 'GET' && m !== 'HEAD') return label(`${verb} with method ${m}`)
      }
      if (args.some((a, k) => (dynArgs[k] === true || /\$\(|`|\$\{/.test(a)) && /^[a-z]+:\/\//i.test(a.replace(/\u0001/g, '')) || (dynArgs[k] === true && /^https?:/.test(a)))) return label(`${verb}: data interpolated into a URL`)
      break
    }
    case 'printenv': {
      const names = options(args).pos
      if (names.length === 0) return label('printenv (prints every environment variable)')
      if (names.some(n => SECRET_NAME.test(n))) return label(`printenv of a secret-named variable (${names.find(n => SECRET_NAME.test(n))})`)
      return { risky: false }
    }
    case 'set':
      if (args.length === 0) return label('set (prints every shell variable)')
      break
    case 'export':
    case 'declare':
    case 'typeset':
      if (args.some(a => a === '-p' || a === '-x' || a === '-xp' || a === '-px')) return label(`${verb} -p (prints environment variables)`)
      break
    case 'compgen':
      if (args.some(a => a === '-e' || a === '-v')) return label('compgen (lists environment variables)')
      break
    case 'rsync': {
      const o = options(args)
      if (o.long.has('--delete') || [...o.long].some(l => l.startsWith('--delete-') || l === '--remove-source-files')) return label('rsync --delete')
      if (o.pos.some(p => /^[^/:\s]+:/.test(p) || /^rsync:\/\//.test(p))) return label('rsync to or from a remote host')
      break
    }
    case 'systemctl': {
      const sub = options(args).pos[0] ?? ''
      if (!/^(status|show|cat|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|--version|help)$/.test(sub)) return label(`systemctl ${sub || ''}`.trim())
      return { risky: false }
    }
    case 'service':
      if ((options(args).pos[1] ?? 'status') !== 'status') return label('service control')
      return { risky: false }
    case 'journalctl':
      if ([...options(args).long].some(l => l.startsWith('--vacuum') || l === '--rotate' || l === '--flush')) return label('journalctl --vacuum')
      return { risky: false }
    case 'docker':
    case 'podman':
    case 'nerdctl':
      return judgeDocker(args)
    case 'kubectl':
    case 'oc': {
      const sub = options(args).pos[0] ?? ''
      if (!/^(get|describe|logs|top|version|explain|api-resources|api-versions|cluster-info|diff|events|wait|config|auth|completion|help)$/.test(sub) || (sub === 'config' && !/\bview\b|get-contexts|current-context/.test(args.join(' '))) || (sub === 'auth' && !/can-i/.test(args.join(' ')))) return label(`${verb} ${sub}`.trim())
      return { risky: false }
    }
    case 'helm': {
      const sub = options(args).pos[0] ?? ''
      if (!/^(list|ls|status|get|show|search|template|lint|version|env|history|dependency|dep|repo|verify|help|plugin)$/.test(sub) || (sub === 'repo' && /\badd|remove|update\b/.test(args.join(' ')))) return label(`helm ${sub}`.trim())
      return { risky: false }
    }
    case 'terraform':
    case 'tofu':
    case 'pulumi':
    case 'ansible-playbook':
    case 'ansible': {
      const sub = options(args).pos[0] ?? ''
      if (verb.startsWith('ansible') || !/^(plan|validate|fmt|init|show|output|version|providers|graph|preview|stack|help|console|state)$/.test(sub) || (sub === 'state' && !/\b(list|show|pull)\b/.test(args.join(' ')))) return label(`${verb} ${sub}`.trim())
      return { risky: false }
    }
    case 'aws':
    case 'gcloud':
    case 'az':
    case 'gsutil':
    case 'doctl':
    case 'oci':
    case 'ibmcloud':
    case 'linode-cli':
    case 'hcloud':
    case 'scw':
    case 'openstack':
      if (/\b(print-access-token|print-identity-token|get-access-token|get-session-token|get-login-password|get-authorization-token|get-secret-value|get-parameters?(-by-path)?|export-credentials|configure\s+get|auth\s+(login|list|token))\b/i.test(args.join(' '))) return label(`${verb} (prints a credential or token)`)
      if (args.some(a => /^(delete|remove|rm|rb|terminate|destroy|deploy|publish|put|create|update|sync|cp|mv|push|apply|purge|drop|detach|modify|invoke|send|attach|empty|restore|rotate|revoke|grant|register|set|reset|start|stop|reboot|run|import|export|enable|disable|add|write|upload|copy|move)$/i.test(a))) return label(`${verb} with a changing subcommand`)
      return { risky: false }
    case 'vercel':
    case 'netlify':
    case 'wrangler':
    case 'heroku':
    case 'flyctl':
    case 'fly':
    case 'railway':
    case 'firebase':
    case 'serverless':
    case 'sls':
    case 'supabase':
    case 'surge':
    case 'now':
      if (!args.every(a => /^(--version|-v|help|whoami|status|logs|list|ls|inspect|--help|-h|dev|info)$/i.test(a))) return label(`${verb} (deploys or changes a hosted service)`)
      return { risky: false }
    case 'gh':
    case 'glab':
    case 'hub':
      return judgeGh(verb, args)
    case 'twine':
    case 'gem':
    case 'cargo':
    case 'composer':
    case 'pip':
    case 'pip3':
    case 'poetry':
    case 'uv':
    case 'mvn':
    case 'gradle':
    case 'dotnet': {
      const sub = options(args).pos[0] ?? ''
      if (/^(upload|publish|push|yank|owner|login|logout|deploy|register|release)$/i.test(sub)) return label(`${verb} ${sub} (publishes a package)`)
      return { risky: false }
    }
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk': {
      const v = judgeAwk(c, verb, args, ctx)
      if (v) return v
      break
    }
    case 'sed': {
      const v = judgeSed(c, ctx)
      if (v) return v
      break
    }
    case 'tar':
      if (args.some(a => /^--(checkpoint-action|to-command|use-compress-program|rsh-command)\b/.test(a) || /^-I$/.test(a))) return label('tar option that runs a command')
      break
    case 'vim':
    case 'vi':
    case 'nvim':
    case 'ex':
    case 'ed':
    case 'emacs':
      if (args.some(a => a === '-c' || a === '--cmd' || a === '-S' || a === '--eval' || a === '--execute' || /^\+/.test(a)) || (verb === 'ed' && c.heredoc !== undefined)) return label(`${verb} with a command to run`)
      break
    case 'ping':
    case 'dig':
    case 'nslookup':
    case 'host':
    case 'traceroute':
    case 'whois':
    case 'drill':
      if (dynArgs.some(Boolean)) return label(`${verb} with data built at run time in the name (a way to send data out)`)
      break
    case 'fallocate':
    case 'mkfifo':
    case 'mknod':
      return label(`${verb} (fills a disk or makes device files)`)
    case 'php':
      if (args.includes('-S')) return label('php -S (serves files to the network)')
      break
    case 'caddy':
    case 'miniserve':
    case 'serve':
    case 'http-server':
    case 'live-server':
    case 'browser-sync':
      return label(`${verb} (serves files to the network)`)
    case 'security':
      if (args.some(a => /^(find-.*|dump-keychain|export|show-keychain-info|list-keychains)$/.test(a))) return label('security (reads the keychain)')
      break
    case 'secret-tool':
    case 'op':
    case 'bw':
    case 'lpass':
    case 'doppler':
    case 'keyctl':
    case 'kwallet-query':
    case 'pass':
      return label(`${verb} (reads a secret store)`)
    case 'vault':
      if (!/^(version|status|--version|-v|help)$/.test(options(args).pos[0] ?? '')) return label('vault (reads or changes secrets)')
      return { risky: false }
    case 'gpg':
    case 'gpg2':
      if (args.some(a => /^--(export-secret-keys|export-secret-subkeys|export-ownertrust|decrypt)$/.test(a) || a === '-d')) return label(`${verb} (exports or decrypts secrets)`)
      break
    case 'ln': {
      const o = options(args)
      const target = o.pos[0]
      if (target && o.pos.length >= 2) {
        const abs = resolveWord(target, ctx)
        if (!insideRepo(abs, ctx) && !isScratch(abs)) return label(`ln to a path outside the repository (${abs})`, 'outside_repo')
        const secret = secretPathLabel(abs, { home: ctx.scope.home, cwd: ctx.cwd })
        if (secret) return label(secret, 'secret')
      }
      break
    }
    default:
  }

  if (SYSTEM_TOOLS.has(verb)) {
    if (verb === 'crontab' && args.includes('-l')) return { risky: false }
    if (verb === 'sysctl' && !args.some(a => a === '-w' || a.includes('='))) return { risky: false }
    if (verb === 'kill' && args.includes('-l')) return { risky: false }
    return label(`${verb} (changes the system or other processes)`)
  }
  if (/^mkfs(\.\w+)?$/.test(verb)) return label(`${verb} (formats a disk)`)
  if (verb === 'mount' && args.length > 0) return label('mount')
  if (PKG_SYSTEM.has(verb)) {
    const sub = options(args).pos[0] ?? ''
    if (!/^(list|show|search|info|policy|depends|rdepends|--version|version|-l|-s|-L|help|-v)$/.test(sub)) return label(`${verb} ${sub} (changes system packages)`)
    return { risky: false }
  }
  if (NETWORK_TOOLS.has(verb)) return label(`${verb} (can send data to another machine)`)
  if (DB_CLIENTS.has(verb)) {
    const text = args.join(' ')
    if (SQL_DANGER.test(text)) return label(`${verb} with a destructive statement`)
    if (c.heredoc && SQL_DANGER.test(c.heredoc)) return label(`${verb} with a destructive statement`)
    const f = args.findIndex(a => a === '-f' || a === '--file' || a === '-i' || a === '--init' || a === '<')
    const file = f >= 0 ? args[f + 1] : c.redirects.find(r => r.op === '<')?.target
    const body = file ? readScript(file, ctx) : null
    if (body && SQL_DANGER.test(body)) return label(`${verb} runs a file with a destructive statement`)
    return { risky: false }
  }
  if (INTERP.test(verb) || SHELLS.has(verb)) return { risky: false }

  // ---- writers: where the data goes
  const targets = makeTargets(c, verb, args)
  for (const t of targets) {
    if (!t) continue
    const out = writeTargetLabel(t, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
    if (out) return label(`${verb}: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
  }

  // ---- readers must not be pointed at a path built at run time
  if (READERS.has(verb) && dynArgs.some(Boolean) && vi('SAFE') === undefined) {
    // A reader whose paths come from plain listers (`awk ... $(find . -name '*.ts')`) is judged by the paths they print.
    const listed = readsOnly(words, i) ? judgeSubstitutedPaths(c, i, ctx) : null
    if (listed === null) return label(`${verb} of a path built at run time (cannot be judged)`, 'secret')
    if (listed.risky) return listed
  }
  void raw
  return { risky: false }
}

function redirectVerdict(c: Cmd, ctx: Ctx): ShellVerdict {
  for (const r of c.redirects) {
    if (r.op === '<' || r.op === '<<' || r.op === '<<<') {
      if (r.op === '<') {
        const s = secretPathLabel(r.target, { home: ctx.scope.home, cwd: ctx.cwd })
        if (s) return label(s, 'secret')
      }
      continue
    }
    if (/^\u0001/.test(r.target) || r.target.includes('\u0001')) return label('a redirect to a path built at run time', 'outside_repo')
    const out = writeTargetLabel(r.target, ctx.scope.repoRoot, ctx.scope.home, ctx.fs, ctx.cwd, ctx.scope.referenceDirs)
    if (out) return label(`redirect: ${out}`, out.startsWith('a write outside') ? 'outside_repo' : 'command')
  }
  return { risky: false }
}

function judgeGit(args: string[], ctx: Ctx): ShellVerdict {
  let i = 0
  // Where git will really work: the directory of `-C`, `--git-dir` and `--work-tree`, else the working directory.
  let workDir = ctx.cwd
  const otherDirs: string[] = []
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!
    const name = a.split('=')[0]!
    if (name === '-c' || name === '--config-env') {
      const value = a.includes('=') && name !== '-c' ? a.slice(a.indexOf('=') + 1) : args[i + 1] ?? ''
      if (GIT_RISKY_CONFIG.test(value)) return label(`git -c ${value.split('=')[0]} (a setting that can run commands or redirect traffic)`)
      i += name === '-c' ? 2 : 1
    } else if (GIT_VALUE_OPTIONS.has(name) && !a.includes('=')) {
      const value = args[i + 1] ?? '.'
      if (name === '-C') workDir = path.resolve(workDir, expandHome(value, ctx.scope.home))
      else if (name === '--git-dir' || name === '--work-tree') otherDirs.push(path.resolve(ctx.cwd, expandHome(value, ctx.scope.home)))
      i += 2
    } else {
      if ((name === '--git-dir' || name === '--work-tree') && a.includes('=')) otherDirs.push(path.resolve(ctx.cwd, expandHome(a.slice(a.indexOf('=') + 1), ctx.scope.home)))
      i += 1
    }
  }
  const sub = args[i] ?? ''
  // A reference repository is read-only: git may look at it (log, show, diff, blame, ...) and may not change it (checkout, pull, commit, ...).
  if (sub !== '' && (ctx.scope.referenceDirs?.length ?? 0) > 0 && !READ_ONLY_GIT.has(sub) && [workDir, ...otherDirs].some(d => inReferenceDir(d, ctx))) {
    return label(`git ${sub} in a reference directory, which is read-only`)
  }
  const rest = args.slice(i + 1)
  const o = options(rest)
  const has = (...f: string[]) => f.some(x => o.short.has(x.replace(/^-/, '')) || o.long.has(x))
  if (sub === '') return { risky: false }
  if (!GIT_KNOWN.has(sub) && !/^-/.test(sub)) return label(`git ${sub} (an unknown subcommand: it may be an alias that runs anything)`)
  switch (sub) {
    case 'push':
    case 'send-pack':
      return label(`git ${sub}`)
    case 'remote':
      if (o.pos.some(p => /^(add|set-url|remove|rm|rename|set-head|set-branches|prune|update)$/.test(p))) return label('git remote (changes where code is sent)')
      return { risky: false }
    case 'reset':
      if (has('--hard', '--merge', '--keep')) return label('git reset --hard')
      return { risky: false }
    case 'clean':
      if (has('-n', '--dry-run')) return { risky: false }
      return label('git clean (deletes untracked files)')
    case 'checkout':
      if (rest.includes('--') && rest.indexOf('--') < rest.length - 1) return label('git checkout -- (discards changes)')
      if (has('-f', '--force', '-B') || o.pos.some(p => p === '.' || p === ':/')) return label('git checkout (discards changes)')
      return { risky: false }
    case 'restore':
      if (has('--staged', '-S') && !has('--worktree', '-W')) return { risky: false }
      return label('git restore (discards changes)')
    case 'switch':
      if (has('-f', '--force', '--discard-changes')) return label('git switch --discard-changes')
      return { risky: false }
    case 'stash':
      if (o.pos.some(p => /^(drop|clear)$/.test(p))) return label('git stash drop/clear')
      return { risky: false }
    case 'branch':
      if (has('-D', '-d', '--delete', '-f', '--force', '-M')) return label('git branch -D (deletes a branch)')
      return { risky: false }
    case 'tag':
      if (has('-d', '--delete', '-f', '--force')) return label('git tag -d (deletes a tag)')
      return { risky: false }
    case 'filter-branch':
    case 'filter-repo':
    case 'prune':
      return label(`git ${sub} (rewrites or destroys history)`)
    case 'reflog':
      if (o.pos.some(p => /^(expire|delete)$/.test(p))) return label('git reflog expire (destroys the safety net)')
      return { risky: false }
    case 'gc':
      if ([...o.long].some(l => l.startsWith('--prune'))) return label('git gc --prune')
      return { risky: false }
    case 'update-ref':
      if (has('-d')) return label('git update-ref -d')
      return { risky: false }
    case 'rebase':
      if (has('--exec', '-x')) return label('git rebase --exec (runs commands)')
      return { risky: false }
    case 'submodule':
      if (o.pos.includes('foreach')) return label('git submodule foreach (runs commands)')
      return { risky: false }
    case 'config': {
      const write = !has('--get', '--get-all', '--get-regexp', '-l', '--list', '--show-origin') && o.pos.length >= 2
      if (has('--global', '--system', '--worktree') && write) return label('git config --global (changes settings outside the repository)')
      if (write && (GIT_RISKY_CONFIG.test(o.pos[0] ?? '') || /^core\./i.test(o.pos[0] ?? ''))) return label(`git config ${o.pos[0]} (a setting that can run commands)`)
      return { risky: false }
    }
    default:
      return { risky: false }
  }
}

function judgeDocker(args: string[]): ShellVerdict {
  const o = options(args)
  const sub = o.pos[0] ?? ''
  const text = args.join(' ')
  if (/^(push|rm|rmi|kill|stop|prune|login|logout|trust|swarm|service|stack|secret)$/.test(sub)) return label(`docker ${sub}`)
  if (/^(system|volume|network|image|container|builder|buildx)$/.test(sub) && /\b(prune|rm|remove|push|kill|stop)\b/.test(text)) return label(`docker ${sub} (removes or publishes)`)
  if (/^(run|create)$/.test(sub) && /--privileged|--pid=host|--net=host|--network=host|--cap-add|-v\s*\/:|--volume\s*\/:|docker\.sock/.test(text)) return label('docker run with host access')
  if (sub === 'compose' && /\b(down|rm)\b/.test(text)) return label('docker compose down')
  return { risky: false }
}

const GH_READ = /^(view|list|ls|status|diff|checks|watch|download|clone|search|browse|--version|version|help|show|get|status|logs|log)$/i
function judgeGh(verb: string, args: string[]): ShellVerdict {
  const o = options(args)
  const sub = o.pos[0] ?? ''
  const action = o.pos[1] ?? ''
  if (sub === 'api') {
    const text = args.join(' ')
    if (/(-X|--method)[ =]?(POST|PUT|PATCH|DELETE)/i.test(text) || o.short.has('f') || o.short.has('F') || o.long.has('--field') || o.long.has('--raw-field') || o.long.has('--input')) return label(`${verb} api with a changing request`)
    return { risky: false }
  }
  if (sub === 'auth' && action !== 'status') return label(`${verb} auth ${action} (handles credentials)`)
  if (sub === 'secret' || sub === 'ssh-key' || sub === 'gpg-key' || sub === 'codespace') return label(`${verb} ${sub}`)
  if (!sub || /^(--version|version|help|browse|status)$/.test(sub)) return { risky: false }
  if (GH_READ.test(action)) return { risky: false }
  return label(`${verb} ${sub} ${action}`.trim())
}

function judgePackageManager(verb: string, args: string[], ctx: Ctx): ShellVerdict {
  const o = options(args.filter(a => !(a.startsWith('--prefix=') || a.startsWith('--dir=') || a.startsWith('--cwd='))))
  // Options that take a value before the subcommand: --prefix X, -C X, --dir X, --workspace X.
  let skip = 0
  const cleaned: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!
    if (skip > 0) {
      skip -= 1
      continue
    }
    if (['--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '-F'].includes(a)) skip = 1
    else if (!a.startsWith('-')) cleaned.push(a)
  }
  void o
  const sub = cleaned[0] ?? ''
  if (verb === 'npx' || verb === 'pnpx' || verb === 'bunx') return /^(serve|http-server|live-server|browser-sync|localtunnel|ngrok|ngrok-cli|cloudflared|local-web-server|vite-preview)$/.test(cleaned.find(a => !a.startsWith('-')) ?? '') ? label(`${verb} ${cleaned[0]} (serves files to the network)`) : { risky: false }
  if (PM_PUBLISH.has(sub)) return label(`${verb} ${sub} (publishes or changes account settings)`)
  if (sub === 'config' && /\b(set|delete|edit|fix)\b/.test(args.join(' '))) return label(`${verb} config set`)
  if (sub === 'config' && /\b(get|list|ls)\b/.test(args.join(' ')) && /auth|token|password|_auth/i.test(args.join(' '))) return label(`${verb} config get of a credential`)
  let script: string | undefined
  if (/^(run|run-script|rum|urn)$/.test(sub)) script = cleaned[1]
  else if (/^(test|t|tst|start|stop|restart)$/.test(sub)) script = sub === 't' || sub === 'tst' ? 'test' : sub
  else if (verb !== 'npm' && sub && !NPM_BUILTIN.has(sub)) script = sub
  if (!script) return { risky: false }
  const pkg = ctx.fs.read(path.join(ctx.cwd, 'package.json')) ?? ctx.fs.read(path.join(ctx.scope.repoRoot, 'package.json'))
  if (!pkg) return { risky: false }
  let scripts: Record<string, unknown> = {}
  try {
    scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return { risky: false }
  }
  for (const name of [`pre${script}`, script, `post${script}`]) {
    const body = scripts[name]
    if (typeof body === 'string') {
      const v = nested(body, ctx, `package script "${name}"`)
      if (v.risky) return v
    }
  }
  return { risky: false }
}

function judgeMake(args: string[], ctx: Ctx): ShellVerdict {
  const file = ctx.fs.read(path.join(ctx.cwd, 'Makefile')) ?? ctx.fs.read(path.join(ctx.cwd, 'makefile')) ?? ctx.fs.read(path.join(ctx.scope.repoRoot, 'Makefile'))
  if (!file) return { risky: false }
  const recipes = new Map<string, { deps: string[]; body: string[] }>()
  let current: string[] = []
  let first = ''
  for (const line of file.split('\n')) {
    const m = /^([A-Za-z0-9_.\-%/]+(?:\s+[A-Za-z0-9_.\-%/]+)*)\s*:(?!=)\s*(.*)$/.exec(line)
    if (m && !line.startsWith('\t')) {
      current = []
      const names = m[1]!.split(/\s+/)
      if (!first) first = names[0]!
      for (const n of names) recipes.set(n, { deps: m[2]!.split(/\s+/).filter(Boolean), body: current })
    } else if (line.startsWith('\t')) current.push(line.slice(1).replace(/^[@\-+]+/, ''))
  }
  const wanted = options(args).pos.filter(a => !a.includes('='))
  const todo = wanted.length ? wanted : first ? [first] : []
  const seen = new Set<string>()
  const visit = (name: string, depth: number): ShellVerdict => {
    if (seen.has(name) || depth > 4) return { risky: false }
    seen.add(name)
    const r = recipes.get(name)
    if (!r) return { risky: false }
    for (const dep of r.deps) {
      const v = visit(dep, depth + 1)
      if (v.risky) return v
    }
    if (r.body.length) {
      const v = nested(r.body.join('\n'), ctx, `make target "${name}"`)
      if (v.risky) return v
    }
    return { risky: false }
  }
  for (const t of todo) {
    const v = visit(t, 0)
    if (v.risky) return v
  }
  return { risky: false }
}

/** `bash x.sh`, `./x.sh`, `source x`, `eval "..."`, `python x.py`, `node -e "..."`, `bash` with a script on stdin. Returns null when this is not a script run. */
function judgeScriptRun(verb: string, raw: string, args: string[], c: Cmd, ctx: Ctx, dynArgs: boolean[]): ShellVerdict | null {
  if (verb === 'eval') return dynArgs.some(Boolean) ? label('eval of a command built at run time') : nested(args.join(' '), ctx, 'eval')
  const isShell = SHELLS.has(verb) || verb === 'source' || verb === '.' || verb === 'busybox'
  const isInterp = INTERP.test(verb)
  const direct = !isShell && !isInterp // `./run.sh`, `scripts/ship.sh`
  if (direct && !raw.includes('/')) return null
  const o = args
  // Inline code: -c (shells) or -e/-c/-p/-r/--eval/-E (interpreters).
  const codeFlag = o.findIndex(a => (isShell ? a === '-c' || /^-[a-zA-Z]*c$/.test(a) : /^(-e|-c|-p|-r|-E|--eval|--exec|--print)$/.test(a)))
  if (codeFlag >= 0 && o[codeFlag + 1] !== undefined) {
    const code = o[codeFlag + 1]!
    if (isShell && dynArgs[codeFlag + 1]) return label(`${verb} -c with a script built at run time`)
    if (isShell) return nested(code, ctx, `${verb} -c`)
    const danger = scriptDanger(code)
    if (danger) return label(`${verb} inline code: ${danger}`)
    // The code is not a path; what it names as a string is.
    return codeLiteralVerdict(code, ctx) ?? { risky: false }
  }
  // A script file.
  let file: string | undefined
  if (direct) file = raw
  else {
    for (let k = 0; k < o.length; k += 1) {
      const a = o[k]!
      if (a === '-m' || a === '-W' || a === '-X' || a === '--require' || a === '--import' || a === '-r' || a === '--loader') {
        if (a === '-m') return /^(http\.server|SimpleHTTPServer|smtpd|pyftpdlib)$/.test(o[k + 1] ?? '') ? label(`${verb} -m ${o[k + 1]} (serves files to the network)`) : { risky: false } // a module run by name
        k += 1
        continue
      }
      if (a.startsWith('-') && a !== '-') continue
      file = a
      break
    }
  }
  if (file === undefined || file === '-') {
    // Reading the program from stdin: a heredoc is read as the script, a pipe cannot be.
    if (c.heredoc !== undefined) {
      if (isShell) return nested(c.heredoc, ctx, `${verb} <<heredoc`)
      const danger = scriptDanger(c.heredoc)
      return danger ? label(`${verb} <<heredoc: ${danger}`) : { risky: false }
    }
    if (c.pipeIn) return label(`a pipe into ${verb} (runs whatever arrives)`)
    return null
  }
  if (/^\/dev\/fd\/\d+$/.test(file) && (isShell || direct)) return label(`${verb} runs a script produced by another command (process substitution)`)
  const abs = resolveWord(file, ctx)
  const body = readScript(file, ctx)
  if (body === null) {
    if (ctx.written.has(abs)) return label(`${verb} runs ${file}, which this command writes itself (cannot be judged)`)
    return null
  }
  const secretPath = secretPathLabel(abs, { home: ctx.scope.home, cwd: ctx.cwd })
  if (secretPath) return label(secretPath, 'secret')
  if (isShell || direct || /^#!.*\b(ba|z|da|k)?sh\b/.test(body)) return nested(body, ctx, `script ${file}`)
  const danger = scriptDanger(body)
  if (danger) return label(`script ${file}: ${danger}`)
  const secret = bashSecretLabel(body.replace(/[()]/g, ' ').replace(/['"]/g, ' ').slice(0, 20000), { home: ctx.scope.home, cwd: ctx.cwd })
  if (secret) return label(`script ${file}: ${secret}`, 'secret')
  return { risky: false }
}

function collectWrites(cmds: Cmd[], ctx: Ctx): void {
  for (const c of cmds) {
    const verb = base(c.words.find(w => !ASSIGN.test(w) && !RESERVED.has(w)) ?? '')
    for (const r of c.redirects) {
      if (!/^>>?|^&>/.test(r.op)) continue
      const abs = resolveWord(r.target, ctx)
      if (c.heredoc !== undefined) ctx.written.set(abs, c.heredoc)
      else if (verb === 'echo' || verb === 'printf') {
        const text = c.words.slice(c.words.indexOf(c.words.find(w => base(w) === verb) ?? '') + 1).filter(w => !w.startsWith('-') || w === '-').join(' ').replace(/\\n/g, '\n')
        ctx.written.set(abs, (ctx.written.get(abs) ?? '') + text + '\n')
      } else ctx.written.set(abs, null)
    }
    if (verb === 'tee') {
      for (const w of c.words.slice(1).filter(w => !w.startsWith('-'))) ctx.written.set(resolveWord(w, ctx), c.heredoc ?? null)
    }
  }
}

function judge(text: string, ctx: Ctx): ShellVerdict {
  if (text.length > MAX_COMMAND) return label('a command too long to judge')
  const subs: string[] = []
  const cmds = parse(text, ctx.vars, subs)
  ctx = { ...ctx, subs }
  collectWrites(cmds, ctx)
  for (const c of cmds) {
    // `cd` is followed so relative paths are read where the command will run.
    const at = c.words.findIndex(w => !ASSIGN.test(w) && !RESERVED.has(w))
    if (at >= 0 && (base(c.words[at]!) === 'cd' || base(c.words[at]!) === 'pushd')) {
      const target = c.words.slice(at + 1).find(w => !w.startsWith('-'))
      if (target) ctx = { ...ctx, cwd: path.resolve(ctx.cwd, expandHome(target, ctx.scope.home)) }
      continue
    }
    const v = judgeCmd(c, ctx)
    if (v.risky) return v
  }
  // The pipe into an interpreter: `curl ... | sh` (the interpreter's own command carries the pipeIn flag; judgeScriptRun reports it).
  for (const s of subs) {
    if (ctx.budget.left <= 0) break
    const v = nested(s, ctx, 'a substitution')
    if (v.risky) return v
  }
  return { risky: false }
}

/** Why this Bash command must be approved by a person, or `{risky:false}`. Pure apart from reading the scripts the command runs. */
export function bashRisk(command: string, scope: ShellScope): ShellVerdict {
  const ctx: Ctx = { scope, fs: scope.fs ?? nodeShellFs, cwd: path.resolve(scope.cwd), vars: new Map(), depth: 0, written: new Map(), budget: { left: 200 }, subs: [], listers: { left: 4, until: Date.now() + 4500 } }
  // The text of the command is judged as a whole first: secret variables and process environments need no parsing.
  if (SECRET_VAR.test(command)) return label(`the value of a secret-named variable (${SECRET_VAR.exec(command)![0]})`, 'secret')
  if (SQL_DANGER.test(command) && /\b(psql|mysql|mariadb|sqlite3?|mongosh?|redis-cli|cqlsh|clickhouse-client|duckdb)\b/i.test(command)) return label('a destructive SQL or database statement')
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return label('a fork bomb')
  try {
    return judge(command, ctx)
  } catch {
    return label('a command the reader could not parse')
  }
}

// ------------------------------------------------------------------------------------------------ the read-only plan

export type ReadPlan = { readOnly: true; targets: string[]; recursive: string[] } | { readOnly: false; why: string }

const PLAN_READERS = new Set(['cat', 'head', 'tail', 'nl', 'tac', 'wc', 'ls', 'stat', 'file', 'du', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'find', 'git'])
const PLAN_GIT_REFUSED = new Set(['diff-tree', 'name-rev', 'merge-base'])
/** Options that make a reader do more than read: run a program, follow a file for ever, read a list of files from another file. */
const PLAN_REFUSED_OPTIONS: Record<string, RegExp> = {
  rg: /^(--pre|--pre-glob|--search-zip|-z|--hostname-bin)(=|$)/,
  wc: /^--files0-from(=|$)/,
  du: /^--files0-from(=|$)/,
  file: /^(-f|--files-from)(=|$)/,
  tail: /^(-f|-F|--follow|--pid)(=|$)/,
  sed: /^(-f|--file|-i|--in-place)(=|$)/,
  awk: /^(-f|--file|-E|-i|--include|-l|--load|--exec)(=|$)/,
  git: /^(--output|--ext-diff|--textconv|--no-index|--open-files-in-pager|--exec-path|-O)/,
}
for (const alias of ['gawk', 'mawk', 'nawk']) PLAN_REFUSED_OPTIONS[alias] = PLAN_REFUSED_OPTIONS.awk!

/**
 * Does this command only read, and which paths does it read? A strict recogniser, the opposite of the guard's "hold what is risky": only
 * `cat head tail nl tac wc ls stat file du grep egrep fgrep rg sed awk find git log|show|diff|blame|...` are known, joined by `;` `&&` `||` `|`, with
 * `cd`, `pwd`, `sort` and `uniq` (flags only); no `-i`, no redirect except into /dev/null, no program file (`-f`), nothing that runs a command (`find
 * -exec`, `awk system`, `sed e`), nothing built at run time except a plain lister (`$(find ...)`), a wildcard that resolves. `targets` are the absolute
 * paths the command names (wildcards and listers resolved, `cd` followed; links are not followed here); `recursive` are the ones a search walks into.
 * Any doubt is `readOnly: false`. Foreman uses it to allow, by itself, a read that cloudcli held for a reason that was never a secret.
 */
// Consumed by `src/tasks/read-allow.ts`, and by the tests.
export function readOnlyPlan(command: string, scope: ShellScope): ReadPlan {
  const no = (why: string): ReadPlan => ({ readOnly: false, why })
  if (command.length > 20_000) return no('the command is too long to judge')
  const fsx = scope.fs ?? nodeShellFs
  const subs: string[] = []
  let cmds: Cmd[]
  try {
    cmds = parse(command, new Map(), subs)
  } catch {
    return no('the command could not be read')
  }
  if (cmds.length === 0) return no('there is no command')
  let ctx: Ctx = { scope, fs: fsx, cwd: path.resolve(scope.cwd), vars: new Map(), depth: 0, written: new Map(), budget: { left: 200 }, subs, listers: { left: 4, until: Date.now() + 4500 } }
  const targets = new Set<string>()
  const recursive = new Set<string>()
  const add = (p: string, walks = false) => {
    const abs = path.resolve(ctx.cwd, expandHome(p, scope.home))
    targets.add(abs)
    if (walks) recursive.add(abs)
  }
  const wildcards = (): SecretScope => ({ home: scope.home, cwd: ctx.cwd, ...(fsx.list ? { list: fsx.list } : {}) })

  for (const c of cmds) {
    if (c.sepAfter === '&') return no('a command run in the background')
    if (c.heredoc !== undefined) return no('a here-document')
    for (const r of c.redirects) {
      if (r.op === '<' && !/[\u0001*?[]/.test(r.target)) add(r.target)
      else if (r.op !== '<' && r.op !== '<<' && r.op !== '<<<' && r.target === '/dev/null') continue
      else return no(`a redirect (${r.op} ${r.target})`)
    }
    const words = c.words
    if (words.length === 0) continue
    if (ASSIGN.test(words[0]!) || RESERVED.has(words[0]!) || c.dynamic[0]) return no('a command that starts with an assignment, a keyword or a run-time name')
    const verb = path.basename(words[0]!)
    const args = words.slice(1)
    if (verb === 'pwd') continue
    if (verb === 'cd') {
      const dest = args[0] ?? ''
      if (args.length !== 1 || dest.startsWith('-') || c.dynamic[1] || /[$\u0001*?[]/.test(dest.replace(/^\$\{?HOME\}?(?=\/|$)/, ''))) return no('a cd to a place that cannot be judged')
      add(dest)
      ctx = { ...ctx, cwd: path.resolve(ctx.cwd, expandHome(dest, scope.home)) }
      continue
    }
    if (verb === 'sort' || verb === 'uniq') {
      if (!args.every(a => /^-[unrfbdisc]+$/.test(a))) return no(`${verb} with an operand`)
      continue
    }
    if (!PLAN_READERS.has(verb) || path.basename(words[0]!) !== words[0]) return no(`${verb} is not a command that only reads`)
    if (!readsOnly(words, 0)) return no(`${verb} in a form that is not read-only`)
    const refused = PLAN_REFUSED_OPTIONS[verb]
    if (refused && args.some(a => refused.test(a))) return no(`${verb} with an option that does more than read`)
    const literal = patternWordIndexes(words)
    let walks = verb === 'rg' || verb === 'du'
    let operandsFrom = 1

    if (verb === 'find') {
      if (args.some(a => FIND_FORBIDDEN.has(a))) return no('find with an action that runs, deletes or writes')
    } else if (verb === 'awk' || verb === 'gawk' || verb === 'mawk' || verb === 'nawk') {
      if (literal.size === 0) return no('an awk program that is not on the command line')
      for (const k of literal) {
        const f = awkFacts(words[k]!)
        if (f.system || f.pipe || f.environ || f.include || f.redirects.length > 0 || f.reads.includes(null)) return no('an awk program that runs a command, writes, or reads a file named at run time')
        for (const file of f.reads) if (file !== null) add(file)
      }
    } else if (verb === 'sed') {
      if (literal.size === 0) return no('a sed script that is not on the command line')
      for (const k of literal) {
        const f = sedFacts(words[k]!.replace(/^--expression=/, ''))
        if (!f.parsed || f.exec || f.writes.length > 0) return no('a sed script that runs a command, writes, or is not understood')
        for (const file of f.reads) add(file)
      }
    } else if (verb === 'git') {
      const sub = gitSubcommand(args)
      if (!READ_ONLY_GIT.has(sub) || PLAN_GIT_REFUSED.has(sub)) return no(`git ${sub} is not a plain read`)
      let k = 0
      while (k < args.length && args[k]!.startsWith('-')) {
        const name = args[k]!.split('=')[0]!
        if (name === '-C' && !args[k]!.includes('=')) {
          const dest = args[k + 1] ?? '.'
          if (c.dynamic[k + 2] || /[$*?[\u0001]/.test(dest)) return no('git -C to a place that cannot be judged')
          add(dest)
          ctx = { ...ctx, cwd: path.resolve(ctx.cwd, expandHome(dest, scope.home)) }
          k += 2
        } else if (GIT_VALUE_OPTIONS.has(name)) return no(`git ${name}`)
        else k += 1
      }
      operandsFrom = k + 2
      add('.')
    } else if (verb === 'ls') {
      walks = args.some(a => /^-[A-Za-z]*R/.test(a) || a === '--recursive')
    } else if (verb === 'grep' || verb === 'egrep' || verb === 'fgrep') {
      walks = args.some(a => /^-[A-Za-z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive' || a === '--directories=recurse')
    }

    // The operands: what the substitutions print, and every other word that is not an option and not program text.
    const listed = substitutionPaths(c, 0, ctx)
    if (listed === null) return no('a path built from something other than a plain lister')
    let operands = 0
    for (const p of listed) {
      const v = judgeListedPath(p, ctx)
      if (v === null) return no('a listed path that cannot be judged')
      if (v.risky) return no(v.matched)
      add(p, walks)
      operands += 1
    }
    for (const [k, word] of words.entries()) {
      if (k < operandsFrom || literal.has(k) || c.dynamic[k] || word.startsWith('-')) continue
      if (verb === 'find' && /^(\(|\)|!|-o|-a)$/.test(word)) continue
      if (/\$/.test(word.replace(/^\$\{?HOME\}?(?=\/|$)/, ''))) return no(`a word with a variable in it (${word})`)
      if (/^~[^/]/.test(word)) return no(`a word that names another user's home (${word})`)
      operands += 1
      if (isGlobWord(word)) {
        const matches = globMatches(word, wildcards())
        if (matches === null) return no(`a wildcard that cannot be resolved (${word})`)
        for (const m of matches) add(m, walks)
        continue
      }
      // `rev:path` of git, `--flag=value`, `user@host:path`: every form a path can take inside one word is judged.
      for (const form of pathCandidates(word)) add(form)
      add(word, walks)
    }
    if (operands === 0 && (verb === 'find' || verb === 'ls' || verb === 'du' || walks)) add('.', walks)
  }
  if (targets.size === 0) return no('the command names no file')
  return { readOnly: true, targets: [...targets], recursive: [...recursive] }
}

/** The first secret below `dir` (by the classes and `scope.patterns`), or `too-big` when it cannot be searched in full, or null. `.git` and `node_modules` are not entered. */
export function secretBelow(dir: string, scope: SecretScope, fsx: ShellFs = nodeShellFs, limit = 20_000): { secret: string } | { tooBig: true } | null {
  const list = fsx.list
  if (!list) return { tooBig: true }
  const stack = [path.resolve(dir)]
  let seen = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = list(current)
    if (entries === null) return { tooBig: true }
    for (const entry of entries) {
      seen += 1
      if (seen > limit) return { tooBig: true }
      const p = path.join(current, entry.name)
      const secret = secretPathLabel(p, scope, { wildcard: false })
      if (secret) return { secret: `${secret} (${p})` }
      // Links are not walked: a search does not follow them, and one may lead anywhere.
      if (entry.dir && entry.name !== '.git' && entry.name !== 'node_modules' && fsx.realpath(p) === path.join(fsx.realpath(current), entry.name)) stack.push(p)
    }
  }
  return null
}

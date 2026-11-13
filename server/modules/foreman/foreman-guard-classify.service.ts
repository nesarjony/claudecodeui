import path from 'node:path'

import {
  bashSecretLabel,
  coversSecretDirectories,
  expandHome,
  globVariants,
  searchTargetLabel,
  secretPathLabel,
  type SecretScope,
} from '@/modules/foreman/foreman-guard-secrets.service.js'
import { bashRisk, nodeShellFs, type ShellFs } from '@/modules/foreman/foreman-guard-shell.service.js'

/**
 * The risky-action classifier shared by Foreman (`src/tasks/risk.ts`) and cloudcli's guard. Pure apart from reading the files
 * a command is about to run and resolving symbolic links, both through `ShellFs`.
 *
 * - Bash: the configured risky patterns over the text; the configured secret patterns and the built-in secret classes over every
 *   word that is a path (not over the text of a program, a pattern or inline code; a wildcard that only a read-only command expands
 *   is resolved against the file system); and the structural reader of `shell.ts` (git global options, `rm -r -f`, `find -delete`,
 *   `sudo`, scripts about to run, writes outside the repository and into a reference directory, uploads, env dumps, ...).
 * - Any tool: a path argument that is a secret by the patterns or the built-in classes, also after `~`/`$HOME` expansion and after
 *   links are followed (a link in the repo that points at `~/.ssh/id_rsa` is that file).
 * - Write, Edit, MultiEdit, NotebookEdit: a target outside the repo root (links followed), or one of the repository's protected
 *   files (`.git/hooks`, `.git/config`, `.claude/`, `.mcp.json`).
 * - Grep and Glob: the search root and file globs, as before.
 */

export type GuardCategory = 'command' | 'secret' | 'outside_repo'
export type GuardVerdict = { risky: false } | { risky: true; category: GuardCategory; matched: string }

export interface CompiledRules {
  riskyPatterns: RegExp[]
  secretPatterns: RegExp[]
  writeOutsideRepo: boolean
  repoRoot: string | null
  home: string
  /** Other repositories the session reads and never writes (`guard.referenceDirs`): a write into one is held whatever else allows it. */
  referenceDirs?: string[]
  /** Directories where plain files may be written (the task's scratch directory, /tmp): inline code may name paths there. */
  scratchDirs?: string[]
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'notebookPath', 'directory', 'dir', 'cwd']
const PATH_LIST_KEYS = ['paths', 'file_paths', 'filePaths']
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'))
    } catch {
      // A broken pattern must not take the guard down; the others still apply.
    }
  }
  return out
}

export function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* plain text */
    }
  }
  return {}
}

const textOf = (input: unknown, record: Record<string, unknown>): string => (typeof record.command === 'string' ? record.command : typeof input === 'string' ? input : JSON.stringify(input ?? ''))

const globValuesOf = (toolName: string, record: Record<string, unknown>): string[] =>
  [record.glob, record.include, toolName === 'Glob' ? record.pattern : undefined].filter((v): v is string => typeof v === 'string' && v.length > 0)

function pathValuesOf(record: Record<string, unknown>): string[] {
  const values: unknown[] = PATH_KEYS.map(k => record[k])
  for (const k of PATH_LIST_KEYS) if (Array.isArray(record[k])) values.push(...(record[k] as unknown[]))
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Repository files a worker has no business writing: they change what later runs (hooks, settings, MCP servers). */
const MCP_CHANGES = /(^|[_\-.])(send|post|create|delete|remove|merge|push|publish|update|write|upload|comment|reply|invite|transfer|pay|deploy|execute|exec|run|drop|insert|set|add|edit|modify|patch|put|rename|move|archive|close|reopen|approve|reject|cancel|schedule|trigger|dispatch|fork|share|grant|revoke|reset|restart|kill|stop|start|install|uninstall|submit|commit|apply|assign|forward|draft)([_\-.]|$)/i
const SECRET_VALUE = /(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|FAKE_SECRET_[A-Za-z0-9_]+)/

/** Every string inside a tool input, however deep. */
function leafStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') out.push(value)
  else if (depth < 6 && value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) leafStrings(v, out, depth + 1)
  return out
}

export const protectedRepoPath = (rel: string): boolean => /(^|\/)(node_modules|\.venv|venv|site-packages)(\/|$)/.test(rel) || /^\.git\/(hooks|config|info\/attributes|modules)(\/|$)/.test(rel) || /^\.claude(\/|$)/.test(rel) || rel === '.mcp.json'

export function classifyCore(call: { toolName: string; input: unknown }, rules: CompiledRules, fsx: ShellFs = nodeShellFs): GuardVerdict {
  const record = asRecord(call.input)
  const text = textOf(call.input, record)
  const home = path.resolve(rules.home)
  const repoRoot = path.resolve(rules.repoRoot ?? '/')
  const scope: SecretScope = { home, cwd: repoRoot, ...(fsx.list ? { list: fsx.list } : {}), real: fsx.realpath, patterns: rules.secretPatterns }
  const secret = (matched: string): GuardVerdict => ({ risky: true, category: 'secret', matched })
  const referenceDirs = (rules.referenceDirs ?? []).filter(dir => path.isAbsolute(dir) && path.resolve(dir) !== path.sep)

  if (call.toolName === 'Bash') {
    for (const re of rules.riskyPatterns) if (re.test(text)) return { risky: true, category: 'command', matched: re.source }
    // The secret patterns are patterns over a path: `bashSecretLabel` applies them to the words of the command that are paths, to redirection
    // targets and to the files a wildcard matches, and not to a program, a regular expression or inline code (`x.key` in `node -e` is a property).
    const reads = bashSecretLabel(text, scope)
    if (reads) return secret(reads)
    const v = bashRisk(text, { ...scope, repoRoot: rules.writeOutsideRepo ? repoRoot : '/', fs: fsx, referenceDirs, scratchDirs: rules.scratchDirs ?? [] })
    if (v.risky) return v
  }

  if (/^mcp__/i.test(call.toolName)) {
    // An MCP tool is someone else's server acting for the worker: sending, creating, merging or deleting through it needs a person; so does a
    // call whose arguments carry a risky command, a secret path or a secret-shaped value.
    const action = call.toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/i, '')
    if (MCP_CHANGES.test(action)) return { risky: true, category: 'command', matched: `an MCP tool that sends, writes or changes something (${call.toolName})` }
    for (const text of leafStrings(call.input)) {
      for (const re of rules.riskyPatterns) if (re.test(text)) return { risky: true, category: 'command', matched: re.source }
      for (const re of rules.secretPatterns) if (re.test(text)) return secret(re.source)
      const label = secretPathLabel(text, scope)
      if (label) return secret(label)
      if (SECRET_VALUE.test(text)) return secret('a secret-shaped value in an MCP call')
    }
  }
  if (call.toolName === 'WebFetch' || call.toolName === 'WebSearch') {
    // The URL (or query) is a channel out: a secret-shaped value, a password in the address, or a long opaque blob in the query string is data leaving.
    for (const text of leafStrings(call.input)) {
      if (SECRET_VALUE.test(text)) return secret('a secret-shaped value in a web request')
      if (/:\/\/[^/@\s:]+:[^/@\s]+@/.test(text)) return secret('a password inside a URL')
      if (/[?&#][^=\s&#]{0,40}=?[A-Za-z0-9+/_=%-]{48,}/.test(text)) return secret('a long opaque value in a URL (data leaving)')
      for (const re of rules.secretPatterns) if (re.test(text)) return secret(re.source)
    }
  }

  const written = WRITE_TOOLS.has(call.toolName)
  for (const value of pathValuesOf(record)) {
    for (const re of rules.secretPatterns) if (re.test(value)) return secret(re.source)
    const label = secretPathLabel(value, scope)
    if (label) return secret(label)
    const resolved = path.resolve(repoRoot, expandHome(value, home))
    const real = fsx.realpath(resolved)
    if (written) {
      const ref = referenceDirs.find(dir => real === fsx.realpath(dir) || real.startsWith(fsx.realpath(dir).replace(/\/$/, '') + path.sep))
      if (ref) return { risky: true, category: 'command', matched: `a write into a reference directory (${ref}), which is read-only` }
    }
    if (real !== resolved) {
      // A link: the file it points at is the file that is read or written.
      const viaLink = secretPathLabel(real, scope)
      if (viaLink) return secret(`${viaLink} (reached through a link)`)
    }
    if (written && rules.repoRoot) {
      const root = fsx.realpath(repoRoot)
      const inside = real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
      if (inside) {
        const rel = path.relative(root, real)
        if (protectedRepoPath(rel)) return { risky: true, category: 'command', matched: `a protected file of the repository (${rel})` }
      } else if (rules.writeOutsideRepo) {
        return { risky: true, category: 'outside_repo', matched: real }
      }
    }
  }

  const globs = globValuesOf(call.toolName, record)
  for (const glob of globs) {
    for (const variant of globVariants(glob)) for (const re of rules.secretPatterns) if (re.test(variant)) return secret(re.source)
  }
  const searchRoot = typeof record.path === 'string' && record.path ? record.path : undefined
  const searched = searchTargetLabel(searchRoot, globs, scope)
  if (searched) return secret(searched)
  if (SEARCH_TOOLS.has(call.toolName) && searchRoot && coversSecretDirectories(searchRoot, scope, true)) return secret('a search from a directory that holds secrets (~, ~/.config, /)')
  return { risky: false }
}

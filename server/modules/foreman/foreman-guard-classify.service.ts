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
 * - Bash: the configured risky patterns over the text; the configured secret patterns over the text; the built-in secret classes
 *   over every word; and the structural reader of `shell.ts` (git global options, `rm -r -f`, `find -delete`, `sudo`, scripts
 *   about to run, writes outside the repository, uploads, env dumps, ...).
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
export const protectedRepoPath = (rel: string): boolean => /^\.git\/(hooks|config|info\/attributes|modules)(\/|$)/.test(rel) || /^\.claude(\/|$)/.test(rel) || rel === '.mcp.json'

export function classifyCore(call: { toolName: string; input: unknown }, rules: CompiledRules, fsx: ShellFs = nodeShellFs): GuardVerdict {
  const record = asRecord(call.input)
  const text = textOf(call.input, record)
  const home = path.resolve(rules.home)
  const repoRoot = path.resolve(rules.repoRoot ?? '/')
  const scope: SecretScope = { home, cwd: repoRoot }
  const secret = (matched: string): GuardVerdict => ({ risky: true, category: 'secret', matched })

  if (call.toolName === 'Bash') {
    for (const re of rules.riskyPatterns) if (re.test(text)) return { risky: true, category: 'command', matched: re.source }
    for (const re of rules.secretPatterns) if (re.test(text)) return secret(re.source)
    const reads = bashSecretLabel(text, scope)
    if (reads) return secret(reads)
    const v = bashRisk(text, { ...scope, repoRoot: rules.writeOutsideRepo ? repoRoot : '/', fs: fsx })
    if (v.risky) return v
  }

  const written = WRITE_TOOLS.has(call.toolName)
  for (const value of pathValuesOf(record)) {
    for (const re of rules.secretPatterns) if (re.test(value)) return secret(re.source)
    const label = secretPathLabel(value, scope)
    if (label) return secret(label)
    const resolved = path.resolve(repoRoot, expandHome(value, home))
    const real = fsx.realpath(resolved)
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

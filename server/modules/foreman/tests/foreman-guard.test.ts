import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
  assertGuardCompatiblePermissionMode,
  classifyToolUse,
  compileGuard,
  createToolPolicy,
  parseGuardConfig,
  type ForemanGuardConfig,
} from '@/modules/foreman/foreman-guard.service.js';
import { AppError } from '@/shared/utils.js';

// Foreman's default rules (src/config.ts DEFAULT_RISKY_COMMAND_PATTERNS / DEFAULT_SECRET_PATH_PATTERNS as of Milestone 5), as it sends them.
const RISKY = [
  'rm\\s+-[a-z]*r[a-z]*f|rm\\s+-[a-z]*f[a-z]*r|rm\\s+(-[a-z]+\\s+)*--recursive',
  '\\bgit\\s+push\\b',
  '\\bgit\\s+reset\\s+--hard',
  '\\bgit\\b[^|;&]*\\s(--force|-f)\\b',
  '\\s--force(-with-lease)?\\b',
  '\\bDROP\\s+(TABLE|DATABASE|SCHEMA)\\b',
  '\\bTRUNCATE\\b',
  'DELETE\\s+FROM\\b',
  '\\b(deploy|kubectl\\s+(delete|apply)|terraform\\s+(apply|destroy)|helm\\s+(install|upgrade|uninstall)|docker\\s+push|npm\\s+publish|pnpm\\s+publish|systemctl\\s+(restart|stop|disable))\\b',
];
const SECRET = [
  '(^|[\\s/\'"=])\\.env(?!\\.(example|sample|template)\\b)(\\.[\\w.-]+)?(?=$|[\\s\'"])',
  '(^|[\\s/\'"=])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?(?=$|[\\s\'"])',
  '\\.(pem|key|p12|pfx)(?=$|[\\s\'"])',
  '(^|[\\s/\'"=])\\.(aws|ssh|gnupg|netrc|npmrc|pypirc)(?=$|[\\s/\'"])',
  '(^|[\\s/\'"=])(credentials|secrets?)(\\.[\\w]+)?(?=$|[\\s\'"])',
  '/\\.config/(foreman|task-queue-mcp)/',
];

const REPO = '/mnt/dev/moveon/desk';
const config = (overrides: Partial<ForemanGuardConfig> = {}): ForemanGuardConfig => ({
  enabled: true,
  riskyPatterns: RISKY,
  secretPatterns: SECRET,
  writeOutsideRepo: true,
  ...overrides,
});
const guard = (overrides: Partial<ForemanGuardConfig> = {}) => compileGuard(config(overrides), REPO);

const bash = (command: string) => ({ toolName: 'Bash', input: { command } });

// ---------------------------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------------------------

test('risky shell commands are classified as command', () => {
  const risky = [
    'rm -rf build',
    'rm -fr node_modules',
    'rm --recursive dist',
    'git push',
    'git push origin main',
    'git push --force',
    'git push -f origin HEAD',
    'git reset --hard HEAD~3',
    'git clean -fd --force',
    'psql -c "DROP TABLE users"',
    'sqlite3 app.db "delete from sessions"',
    'psql -c "TRUNCATE orders"',
    './scripts/deploy.sh staging',
    'kubectl apply -f k8s/prod.yaml',
    'terraform apply -auto-approve',
    'helm upgrade api ./chart',
    'docker push registry/app:1',
    'npm publish',
    'systemctl restart nginx',
  ];
  for (const command of risky) {
    const verdict = classifyToolUse(bash(command), guard());
    assert.equal(verdict.risky, true, command);
    assert.equal(verdict.risky && verdict.category, 'command', command);
  }
});

test('ordinary development commands are safe', () => {
  const safe = [
    'node --test',
    'node --test server/modules/foreman/tests',
    'ls -la',
    'git status',
    'git diff',
    'git diff HEAD --stat',
    'git log --oneline -5',
    'git commit -m "feat: x"',
    'pnpm verify',
    'rm build/output.txt',
    'cat package.json',
    'grep -rn envelope src',
    'cat .env.example',
    'echo hello > out.txt',
  ];
  for (const command of safe) {
    assert.deepEqual(classifyToolUse(bash(command), guard()), { risky: false }, command);
  }
});

test('a Bash command that names a secret file is classified as secret', () => {
  for (const command of ['cat .env', 'cat ./.env.production', 'less config/.env', 'cp ~/.ssh/id_rsa /tmp/k', 'cat server.pem', 'ls ~/.aws/']) {
    const verdict = classifyToolUse(bash(command), guard());
    assert.equal(verdict.risky, true, command);
    assert.equal(verdict.risky && verdict.category, 'secret', command);
  }
});

test('a command that is both risky and secret reports the command rule first', () => {
  const verdict = classifyToolUse(bash('rm -rf .env'), guard());
  assert.equal(verdict.risky && verdict.category, 'command');
});

test('any tool reading a secret path is classified as secret', () => {
  const reads = [
    { toolName: 'Read', input: { file_path: '/mnt/dev/moveon/desk/.env' } },
    { toolName: 'Read', input: { file_path: '/home/nesar/.ssh/id_rsa' } },
    { toolName: 'Read', input: { file_path: '/mnt/dev/moveon/desk/.env.local' } },
    { toolName: 'Grep', input: { pattern: 'KEY', path: '/mnt/dev/moveon/desk/.aws/credentials' } },
    { toolName: 'NotebookEdit', input: { notebook_path: '/mnt/dev/moveon/desk/secrets.json' } },
    { toolName: 'Edit', input: { file_path: '/mnt/dev/moveon/desk/.env', old_string: 'a', new_string: 'b' } },
  ];
  for (const call of reads) {
    const verdict = classifyToolUse(call, guard());
    assert.equal(verdict.risky, true, JSON.stringify(call));
    assert.equal(verdict.risky && verdict.category, 'secret', JSON.stringify(call));
  }
  assert.deepEqual(classifyToolUse({ toolName: 'Read', input: { file_path: '/mnt/dev/moveon/desk/src/env.ts' } }, guard()), { risky: false });
  assert.deepEqual(classifyToolUse({ toolName: 'Read', input: { file_path: '/mnt/dev/moveon/desk/.env.example' } }, guard()), { risky: false });
});

test('a secret pattern in a Bash-only rule is not applied to other tools reading text', () => {
  // Only path arguments are checked for non-Bash tools; a Write whose content mentions .env is not a secret path.
  const verdict = classifyToolUse({ toolName: 'Write', input: { file_path: `${REPO}/README.md`, content: 'copy .env.example to .env' } }, guard());
  assert.deepEqual(verdict, { risky: false });
});

test('writes outside the repo root are classified as outside_repo; writes inside are safe', () => {
  const outside = [
    { toolName: 'Write', input: { file_path: '/etc/hosts', content: 'x' } },
    { toolName: 'Write', input: { file_path: '/mnt/dev/moveon/desk-other/a.ts', content: 'x' } },
    { toolName: 'Edit', input: { file_path: `${REPO}/../elsewhere/a.ts`, old_string: 'a', new_string: 'b' } },
    { toolName: 'MultiEdit', input: { file_path: '/tmp/a.ts', edits: [] } },
    { toolName: 'NotebookEdit', input: { notebook_path: '/home/nesar/n.ipynb' } },
    { toolName: 'Write', input: { file_path: '../escape.ts', content: 'x' } },
  ];
  for (const call of outside) {
    const verdict = classifyToolUse(call, guard());
    assert.equal(verdict.risky, true, JSON.stringify(call));
    assert.equal(verdict.risky && verdict.category, 'outside_repo', JSON.stringify(call));
  }

  const inside = [
    { toolName: 'Edit', input: { file_path: `${REPO}/src/app.ts`, old_string: 'a', new_string: 'b' } },
    { toolName: 'Write', input: { file_path: `${REPO}/docs/new.md`, content: 'x' } },
    { toolName: 'Write', input: { file_path: 'src/relative.ts', content: 'x' } },
    { toolName: 'MultiEdit', input: { file_path: `${REPO}/src/a.ts`, edits: [] } },
  ];
  for (const call of inside) {
    assert.deepEqual(classifyToolUse(call, guard()), { risky: false }, JSON.stringify(call));
  }
});

test('the outside_repo check names the resolved target, and only applies to write tools', () => {
  const verdict = classifyToolUse({ toolName: 'Write', input: { file_path: `${REPO}/../x.ts`, content: '' } }, guard());
  assert.deepEqual(verdict, { risky: true, category: 'outside_repo', matched: '/mnt/dev/moveon/x.ts' });
  // Reading outside the repo is not a write.
  assert.deepEqual(classifyToolUse({ toolName: 'Read', input: { file_path: '/etc/hostname' } }, guard()), { risky: false });
  assert.deepEqual(classifyToolUse({ toolName: 'Glob', input: { pattern: '*.ts', path: '/usr/lib' } }, guard()), { risky: false });
});

test('writeOutsideRepo=false switches the outside_repo rule off; repoRoot overrides the project path', () => {
  const call = { toolName: 'Write', input: { file_path: '/tmp/a.ts', content: 'x' } };
  assert.deepEqual(classifyToolUse(call, guard({ writeOutsideRepo: false })), { risky: false });

  const worktree = guard({ repoRoot: '/mnt/dev/moveon/desk-wt/task-1' });
  assert.deepEqual(classifyToolUse({ toolName: 'Write', input: { file_path: '/mnt/dev/moveon/desk-wt/task-1/a.ts', content: '' } }, worktree), { risky: false });
  const verdict = classifyToolUse({ toolName: 'Write', input: { file_path: `${REPO}/a.ts`, content: '' } }, worktree);
  assert.equal(verdict.risky && verdict.category, 'outside_repo');
});

test('patterns are case-insensitive, and invalid patterns are skipped and counted without disabling the rest', () => {
  const compiled = guard({ riskyPatterns: ['(unclosed', ...RISKY] });
  assert.equal(compiled.skippedPatterns, 1);
  assert.equal(classifyToolUse(bash('GIT PUSH origin main'), compiled).risky, true);
  assert.equal(classifyToolUse(bash('drop table users'), compiled).risky, true);
  assert.equal(guard().skippedPatterns, 0);
});

test('tool input given as a JSON string or plain text is still judged', () => {
  assert.equal(classifyToolUse({ toolName: 'Bash', input: JSON.stringify({ command: 'git push' }) }, guard()).risky, true);
  assert.equal(classifyToolUse({ toolName: 'Bash', input: 'git push' }, guard()).risky, true);
  assert.equal(classifyToolUse({ toolName: 'Bash', input: undefined }, guard()).risky, false);
  assert.equal(classifyToolUse({ toolName: 'Bash', input: null }, guard()).risky, false);
});

// ---------------------------------------------------------------------------------------------
// The per-session policy handed to the runtime
// ---------------------------------------------------------------------------------------------

test('the tool policy allows safe calls and asks for risky ones, naming the category', () => {
  const policy = createToolPolicy(guard());
  assert.deepEqual(policy('Bash', { command: 'git status' }), { decision: 'allow' });
  assert.deepEqual(policy('Edit', { file_path: `${REPO}/src/a.ts`, old_string: 'a', new_string: 'b' }), { decision: 'allow' });
  assert.deepEqual({ ...policy('Bash', { command: 'git push --force' }), timeoutMessage: undefined }, {
    decision: 'ask',
    category: 'command',
    matched: RISKY[1],
    timeoutMs: DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
    timeoutMessage: undefined,
  });
  const secret = policy('Read', { file_path: `${REPO}/.env` });
  assert.equal(secret.decision, 'ask');
  assert.equal(secret.decision === 'ask' && secret.category, 'secret');
  const outside = policy('Write', { file_path: '/etc/passwd', content: '' });
  assert.equal(outside.decision === 'ask' && outside.category, 'outside_repo');
});

test('a classifier fault is a prompt, never an allow', () => {
  const broken = guard();
  Object.defineProperty(broken, 'riskyPatterns', { get: () => { throw new Error('boom'); } });
  const policy = createToolPolicy(broken);
  const verdict = policy('Bash', { command: 'ls' });
  assert.equal(verdict.decision, 'ask');
  assert.equal(verdict.decision === 'ask' && verdict.matched, 'classifier-error');
  assert.equal(verdict.decision === 'ask' && verdict.timeoutMs, DEFAULT_GUARD_APPROVAL_TIMEOUT_MS);
});

test('a risky call waits for the guard\'s approval window, and a timeout says it timed out waiting for a person', () => {
  assert.equal(DEFAULT_GUARD_APPROVAL_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(guard().approvalTimeoutMs, 30 * 60 * 1000);

  const custom = createToolPolicy(guard({ approvalTimeoutMs: 90_000 }));
  const asked = custom('Bash', { command: 'git push' });
  assert.equal(asked.decision, 'ask');
  if (asked.decision !== 'ask') return;
  assert.equal(asked.timeoutMs, 90_000);
  assert.match(asked.timeoutMessage, /^Timed out waiting for a person to approve this Bash call: no one answered within 90 seconds\./);
  assert.match(asked.timeoutMessage, /not a decision: no person said no/);
  assert.match(asked.timeoutMessage, /was not run/);
  assert.doesNotMatch(asked.timeoutMessage, /denied by|refused by|user denied/i);

  const standard = createToolPolicy(guard());
  const long = standard('Read', { file_path: `${REPO}/.env` });
  assert.equal(long.decision === 'ask' && long.timeoutMs, 1_800_000);
  assert.match(long.decision === 'ask' ? long.timeoutMessage : '', /this Read call: no one answered within 30 minutes\./);
  const hours = createToolPolicy(guard({ approvalTimeoutMs: 6 * 3_600_000 }))('Bash', { command: 'git push' });
  assert.match(hours.decision === 'ask' ? hours.timeoutMessage : '', /within 6 hours\./);
  const second = createToolPolicy(guard({ approvalTimeoutMs: 1000 }))('Bash', { command: 'git push' });
  assert.match(second.decision === 'ask' ? second.timeoutMessage : '', /within 1 second\./);

  // Safe calls have no window: they are never asked.
  assert.deepEqual(standard('Bash', { command: 'git status' }), { decision: 'allow' });
});

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------

function rejects(raw: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseGuardConfig(raw),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'INVALID_REQUEST' && pattern.test(error.message),
  );
}

test('parseGuardConfig accepts a full guard and applies the defaults', () => {
  assert.equal(parseGuardConfig(undefined), undefined);
  assert.equal(parseGuardConfig(null), undefined);
  assert.deepEqual(parseGuardConfig({ enabled: true, riskyPatterns: ['a'], secretPatterns: [], writeOutsideRepo: false, repoRoot: ' /mnt/dev/x ' }), {
    enabled: true,
    riskyPatterns: ['a'],
    secretPatterns: [],
    writeOutsideRepo: false,
    repoRoot: '/mnt/dev/x',
    approvalTimeoutMs: 1_800_000,
  });
  // Unspecified writeOutsideRepo means the stricter choice; no repoRoot key when none was given.
  assert.deepEqual(parseGuardConfig({ enabled: true, riskyPatterns: [], secretPatterns: [] }), {
    enabled: true,
    riskyPatterns: [],
    secretPatterns: [],
    writeOutsideRepo: true,
    approvalTimeoutMs: 1_800_000,
  });
  assert.equal(parseGuardConfig({ enabled: false })?.enabled, false);
});

test('parseGuardConfig takes an optional approvalTimeoutMs between one second and one day', () => {
  const guardWith = (approvalTimeoutMs: unknown) => ({ enabled: true, riskyPatterns: [], secretPatterns: [], approvalTimeoutMs });
  assert.equal(parseGuardConfig(guardWith(1000))?.approvalTimeoutMs, 1000);
  assert.equal(parseGuardConfig(guardWith(120_000))?.approvalTimeoutMs, 120_000);
  assert.equal(parseGuardConfig(guardWith(86_400_000))?.approvalTimeoutMs, 86_400_000);
  assert.equal(parseGuardConfig(guardWith(undefined))?.approvalTimeoutMs, 1_800_000);
  assert.equal(parseGuardConfig(guardWith(null))?.approvalTimeoutMs, 1_800_000);

  for (const bad of [999, 0, -5, 86_400_001, 1500.5, '60000', Number.NaN, Infinity, true, [], {}]) {
    rejects(guardWith(bad), /guard\.approvalTimeoutMs must be an integer between 1000 and 86400000/);
  }
  // A disabled guard enforces nothing, so its window is not examined.
  assert.equal(parseGuardConfig({ enabled: false, approvalTimeoutMs: 5 })?.enabled, false);
});

test('parseGuardConfig rejects malformed guards', () => {
  rejects('yes', /guard must be an object/);
  rejects([], /guard must be an object/);
  rejects({}, /guard\.enabled/);
  rejects({ enabled: 'true' }, /guard\.enabled/);
  rejects({ enabled: true, secretPatterns: [] }, /riskyPatterns/);
  rejects({ enabled: true, riskyPatterns: [] }, /secretPatterns/);
  rejects({ enabled: true, riskyPatterns: 'git push', secretPatterns: [] }, /riskyPatterns/);
  rejects({ enabled: true, riskyPatterns: [1], secretPatterns: [] }, /riskyPatterns entries/);
  rejects({ enabled: true, riskyPatterns: [''], secretPatterns: [] }, /riskyPatterns entries/);
  rejects({ enabled: true, riskyPatterns: ['x'.repeat(1001)], secretPatterns: [] }, /riskyPatterns entries/);
  rejects({ enabled: true, riskyPatterns: new Array(201).fill('a'), secretPatterns: [] }, /at most 200/);
  rejects({ enabled: true, riskyPatterns: [], secretPatterns: [], writeOutsideRepo: 'no' }, /writeOutsideRepo/);
  rejects({ enabled: true, riskyPatterns: [], secretPatterns: [], repoRoot: 'relative/path' }, /repoRoot/);
  rejects({ enabled: true, riskyPatterns: [], secretPatterns: [], repoRoot: 5 }, /repoRoot/);
});

test('modes the CLI settles on its own are refused for a guarded session', () => {
  for (const mode of ['acceptEdits', 'auto', 'bypassPermissions']) {
    assert.throws(
      () => assertGuardCompatiblePermissionMode(mode),
      (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'GUARD_INCOMPATIBLE_PERMISSION_MODE',
    );
  }
  for (const mode of ['default', 'plan', undefined]) {
    assert.doesNotThrow(() => assertGuardCompatiblePermissionMode(mode));
  }
});

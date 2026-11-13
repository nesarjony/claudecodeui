import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ASK_USER_QUESTION_DENIAL,
  DEFAULT_GUARD_APPROVAL_TIMEOUT_MS,
  EXIT_PLAN_MODE_DENIAL,
  assertGuardCompatiblePermissionMode,
  classifyToolUse,
  compileGuard,
  createToolPolicy,
  ensureAllowWriteDirs,
  guardHooks,
  guardRunOptions,
  parseGuardConfig,
  unattendedToolDenial,
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

test('Glob and Grep globs that can match a secret file are classified as secret, wildcards included', () => {
  const flagged: Array<{ toolName: string; input: Record<string, unknown> }> = [
    { toolName: 'Glob', input: { pattern: '**/.env*' } },
    { toolName: 'Glob', input: { pattern: '.env.*' } },
    { toolName: 'Glob', input: { pattern: '**/.env' } },
    { toolName: 'Glob', input: { pattern: '{.env,config.json}' } },
    { toolName: 'Glob', input: { pattern: '**/id_rsa*' } },
    { toolName: 'Glob', input: { pattern: '**/*.pem' } },
    { toolName: 'Glob', input: { pattern: '*.{pem,key}' } },
    { toolName: 'Glob', input: { pattern: '**/credentials*' } },
    { toolName: 'Glob', input: { pattern: '**/secrets.*' } },
    { toolName: 'Glob', input: { pattern: '**/secret*' } },
    { toolName: 'Glob', input: { pattern: '*', path: '/home/nesar/.ssh' } },
    { toolName: 'Glob', input: { pattern: '/home/nesar/.ssh/**' } },
    { toolName: 'Grep', input: { pattern: 'KEY', glob: '.env*' } },
    { toolName: 'Grep', input: { pattern: 'KEY', glob: '*.{ts,pem}' } },
    { toolName: 'Grep', input: { pattern: 'KEY', glob: '**/.env.*' } },
    { toolName: 'Grep', input: { pattern: 'x', path: '/home/nesar/.aws/credentials' } },
  ];
  for (const call of flagged) {
    const verdict = classifyToolUse(call, guard());
    assert.equal(verdict.risky, true, JSON.stringify(call));
    assert.equal(verdict.risky && verdict.category, 'secret', JSON.stringify(call));
  }
});

test('ordinary Glob and Grep calls are safe, and Grep\'s pattern is a content search, not a file name', () => {
  const safe: Array<{ toolName: string; input: Record<string, unknown> }> = [
    { toolName: 'Glob', input: { pattern: 'src/**/*.ts' } },
    { toolName: 'Glob', input: { pattern: '**/*.md', path: `${REPO}/docs` } },
    { toolName: 'Glob', input: { pattern: '**/*' } },
    { toolName: 'Glob', input: { pattern: '**/.env.example' } },
    { toolName: 'Glob', input: { pattern: 'docs/**/credentials-guide.md' } },
    { toolName: 'Grep', input: { pattern: 'password', path: `${REPO}/src` } },
    { toolName: 'Grep', input: { pattern: '.env', path: `${REPO}/src`, glob: '*.ts' } },
    { toolName: 'Grep', input: { pattern: 'secret', glob: '**/*.{ts,tsx}' } },
    { toolName: 'Read', input: { file_path: `${REPO}/src/env.ts` } },
  ];
  for (const call of safe) {
    assert.deepEqual(classifyToolUse(call, guard()), { risky: false }, JSON.stringify(call));
  }
  // `pattern` is only a file glob for Glob.
  assert.deepEqual(classifyToolUse({ toolName: 'Grep', input: { pattern: '**/.env*' } }, guard()), { risky: false });
});

// ---------------------------------------------------------------------------------------------
// The PreToolUse hook of a guarded run
// ---------------------------------------------------------------------------------------------

const preToolUse = (toolName: unknown, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'prov-1',
  transcript_path: '/tmp/t.jsonl',
  cwd: REPO,
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'tu_1',
});

async function runHook(input: unknown, overrides: Partial<ForemanGuardConfig> = {}): Promise<Record<string, any>> {
  const registered = guardHooks(guard(overrides));
  return registered.PreToolUse[0].hooks[0](input);
}

test('the guard hook registers one PreToolUse matcher for every tool', () => {
  const hooks = guardHooks(guard());
  assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, '');
  assert.equal(hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(typeof hooks.PreToolUse[0].hooks[0], 'function');

  const options = guardRunOptions(guard());
  assert.equal(typeof options.toolPolicy, 'function');
  assert.equal(options.toolHooks.PreToolUse.length, 1);
});

test('the hook answers ask for risky calls, including the ones the CLI would allow by itself', async () => {
  const risky: Array<[string, unknown, RegExp]> = [
    ['Read', { file_path: `${REPO}/.env` }, /a secret or credential path/],
    ['Read', { file_path: '/home/nesar/.ssh/id_rsa' }, /a secret or credential path/],
    ['Glob', { pattern: '**/.env*' }, /a secret or credential path/],
    ['Grep', { pattern: 'KEY', glob: '.env*' }, /a secret or credential path/],
    ['Grep', { pattern: 'KEY', path: '/home/nesar/.aws/credentials' }, /a secret or credential path/],
    ['NotebookEdit', { notebook_path: `${REPO}/secrets.json` }, /a secret or credential path/],
    ['Bash', { command: 'cat .env' }, /a secret or credential path/],
    ['Bash', { command: 'git push origin main' }, /a risky command/],
    ['Write', { file_path: '/etc/hosts', content: '' }, /a write outside the repository root/],
  ];
  for (const [toolName, toolInput, reason] of risky) {
    const output = await runHook(preToolUse(toolName, toolInput));
    assert.deepEqual(Object.keys(output), ['hookSpecificOutput'], `${toolName} ${JSON.stringify(toolInput)}`);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'ask', `${toolName} ${JSON.stringify(toolInput)}`);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /^Foreman guard: /);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, reason);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /a person must approve this call/);
  }
});

test('the hook answers nothing for safe calls: it never allows anything by itself (AskUserQuestion and ExitPlanMode are not safe: see below)', async () => {
  const safe: Array<[string, unknown]> = [
    ['Read', { file_path: `${REPO}/src/app.ts` }],
    ['Read', { file_path: `${REPO}/.env.example` }],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Grep', { pattern: 'password', path: `${REPO}/src` }],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'node --test' }],
    ['Edit', { file_path: `${REPO}/src/app.ts`, old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: `${REPO}/docs/new.md`, content: 'x' }],
    ['TodoWrite', { todos: [] }],
    ['WebFetch', { url: 'https://example.com' }],
  ];
  for (const [toolName, toolInput] of safe) {
    assert.deepEqual(await runHook(preToolUse(toolName, toolInput)), {}, `${toolName} ${JSON.stringify(toolInput)}`);
  }
});

const ASK_USER_QUESTION_TEXT = 'Foreman guard: no person is available to answer AskUserQuestion in this session, because Foreman runs it. Decide per the repo docs, or list the question in your final report under OPEN QUESTIONS and carry on with the parts that do not depend on it. Never guess an answer to a question the repo documents as open for a person (for example EVIDENCE §7).';
const EXIT_PLAN_MODE_TEXT = 'Foreman guard: no person is available to approve a plan in this session, because Foreman runs it. Do not use plan mode: carry out the work directly.';

test('the refusals for AskUserQuestion and ExitPlanMode are fixed texts, exported for the runtime, and match those two tools only', () => {
  assert.equal(ASK_USER_QUESTION_DENIAL, ASK_USER_QUESTION_TEXT);
  assert.equal(EXIT_PLAN_MODE_DENIAL, EXIT_PLAN_MODE_TEXT);
  assert.equal(unattendedToolDenial('AskUserQuestion'), ASK_USER_QUESTION_TEXT);
  assert.equal(unattendedToolDenial('ExitPlanMode'), EXIT_PLAN_MODE_TEXT);
  for (const other of ['Read', 'Bash', 'TodoWrite', 'askuserquestion', 'AskUserQuestion ', 'exit_plan_mode', 'mcp__notes__AskUserQuestion', 'ExitPlanModeX', '', 'constructor', '__proto__', 'toString', undefined, null, 7, {}, ['AskUserQuestion']]) {
    assert.equal(unattendedToolDenial(other), null, String(other));
  }
});

const PERMISSION_MODES: Array<string | undefined> = ['default', 'plan', 'bypassPermissions', 'acceptEdits', 'auto', 'dontAsk', 'some-future-mode', undefined];
const withMode = (input: Record<string, unknown>, mode: string | undefined) => (mode === undefined ? input : { ...input, permission_mode: mode });

test('the hook denies AskUserQuestion and ExitPlanMode with the exact reason in every permission mode, and never asks', async () => {
  const unattended: Array<[string, unknown, string]> = [
    ['AskUserQuestion', { questions: [] }, ASK_USER_QUESTION_TEXT],
    ['AskUserQuestion', { questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] }] }, ASK_USER_QUESTION_TEXT],
    ['AskUserQuestion', undefined, ASK_USER_QUESTION_TEXT],
    ['ExitPlanMode', { plan: '# Plan\n1. Do the work' }, EXIT_PLAN_MODE_TEXT],
    ['ExitPlanMode', undefined, EXIT_PLAN_MODE_TEXT],
  ];
  for (const mode of PERMISSION_MODES) {
    for (const [toolName, toolInput, reason] of unattended) {
      const label = `${toolName} in ${mode ?? 'no mode'} ${JSON.stringify(toolInput)}`;
      assert.deepEqual(await runHook(withMode(preToolUse(toolName, toolInput), mode)), {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }, label);
    }
  }
  // A permission mode that is not a string reads as no mode at all.
  assert.equal((await runHook({ ...preToolUse('AskUserQuestion', {}), permission_mode: 7 })).hookSpecificOutput.permissionDecision, 'deny');
});

test('the denial of AskUserQuestion and ExitPlanMode does not depend on the guard\'s rules or on who asks', async () => {
  const bare = { riskyPatterns: [], secretPatterns: [], writeOutsideRepo: false };
  for (const [toolName, reason] of [['AskUserQuestion', ASK_USER_QUESTION_TEXT], ['ExitPlanMode', EXIT_PLAN_MODE_TEXT]] as const) {
    const call = preToolUse(toolName, {});
    assert.equal((await runHook(call, bare)).hookSpecificOutput.permissionDecisionReason, reason);
    // A subagent's call is refused exactly like the main worker's.
    const fromSubagent = { ...call, agent_id: 'a98c5140240c80a8e', agent_type: 'explorer' };
    assert.deepEqual(await runHook(fromSubagent), await runHook(call));
    assert.equal((await runHook(fromSubagent)).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('the hook still answers nothing for ordinary safe calls, in every permission mode', async () => {
  const safe: Array<[string, unknown]> = [
    ['Read', { file_path: `${REPO}/src/app.ts` }],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Bash', { command: 'git status' }],
    ['Edit', { file_path: `${REPO}/src/app.ts`, old_string: 'a', new_string: 'b' }],
    ['TodoWrite', { todos: [] }],
    ['WebFetch', { url: 'https://example.com' }],
    // Only the two built-in tools are refused: a lookalike name is judged like any other tool.
    ['mcp__notes__AskUserQuestion', { questions: [] }],
    ['ExitPlanModeX', {}],
  ];
  for (const mode of PERMISSION_MODES) {
    for (const [toolName, toolInput] of safe) {
      assert.deepEqual(await runHook(withMode(preToolUse(toolName, toolInput), mode)), {}, `${toolName} in ${mode ?? 'no mode'}`);
    }
  }
});

test('the tool policy refuses AskUserQuestion and ExitPlanMode outright, whatever the input and even if the classifier is broken', () => {
  const policy = createToolPolicy(guard());
  assert.deepEqual(policy('AskUserQuestion', { questions: [] }), { decision: 'deny', message: ASK_USER_QUESTION_TEXT });
  assert.deepEqual(policy('AskUserQuestion', undefined), { decision: 'deny', message: ASK_USER_QUESTION_TEXT });
  assert.deepEqual(policy('ExitPlanMode', { plan: 'x' }), { decision: 'deny', message: EXIT_PLAN_MODE_TEXT });

  const broken = guard();
  Object.defineProperty(broken, 'riskyPatterns', { get: () => { throw new Error('boom'); } });
  assert.deepEqual(createToolPolicy(broken)('AskUserQuestion', {}), { decision: 'deny', message: ASK_USER_QUESTION_TEXT });

  // Every other tool is judged as before.
  assert.deepEqual(policy('TodoWrite', { todos: [] }), { decision: 'allow' });
  assert.equal(policy('Bash', { command: 'git push' }).decision, 'ask');

  // What a guarded run hands the runtime carries the same refusal in its policy and in its hook.
  const options = guardRunOptions(guard());
  assert.deepEqual(options.toolPolicy('ExitPlanMode', {}), { decision: 'deny', message: EXIT_PLAN_MODE_TEXT });
});

test('the hook follows the guard\'s own rules: a disabled outside-repo rule, another repo root', async () => {
  const write = preToolUse('Write', { file_path: '/tmp/a.ts', content: '' });
  assert.deepEqual(await runHook(write, { writeOutsideRepo: false }), {});
  assert.equal((await runHook(write)).hookSpecificOutput.permissionDecision, 'ask');
  const worktree = { repoRoot: '/mnt/dev/moveon/desk-wt/t1' };
  assert.deepEqual(await runHook(preToolUse('Write', { file_path: '/mnt/dev/moveon/desk-wt/t1/a.ts', content: '' }), worktree), {});
});

test('a tool call the hook cannot read is asked about, and the hook never throws', async () => {
  for (const input of [undefined, null, 'Read', 42, {}, { tool_name: '' }, { tool_name: 7, tool_input: {} }]) {
    const output = await runHook(input);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(input));
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /could not be read/);
  }
  // A tool call with no input at all is judged by its name alone: nothing risky about it.
  assert.deepEqual(await runHook({ tool_name: 'TodoRead' }), {});
});

test('a subagent\'s calls are held exactly like the main worker\'s: agent_id and agent_type change nothing', async () => {
  // Shaped like what Claude Code 2.1.286 sends for a tool call made inside a subagent (seen in a real run): the hook input
  // carries agent_id and agent_type, and canUseTool's options carry agentID. The guard reads none of them.
  const fromSubagent = (toolName: string, toolInput: unknown, agentType: string) =>
    ({ ...preToolUse(toolName, toolInput), agent_id: 'a98c5140240c80a8e', agent_type: agentType });

  const risky = await runHook(fromSubagent('Bash', { command: 'git push origin main' }, 'test-runner'));
  assert.equal(risky.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(risky.hookSpecificOutput.permissionDecisionReason, /a risky command/);
  const secret = await runHook(fromSubagent('Read', { file_path: `${REPO}/.env` }, 'explorer'));
  assert.equal(secret.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(secret.hookSpecificOutput.permissionDecisionReason, /a secret or credential path/);
  const shellSecret = await runHook(fromSubagent('Bash', { command: 'cat .env' }, 'reviewer'));
  assert.equal(shellSecret.hookSpecificOutput.permissionDecision, 'ask');

  // The very same answers the main worker gets for those calls.
  assert.deepEqual(risky, await runHook(preToolUse('Bash', { command: 'git push origin main' })));
  assert.deepEqual(secret, await runHook(preToolUse('Read', { file_path: `${REPO}/.env` })));

  // In a mode that cannot hold a call, a subagent's risky call is denied outright, like the main worker's.
  const bypass = await runHook({ ...fromSubagent('Bash', { command: 'git push' }, 'test-runner'), permission_mode: 'bypassPermissions' });
  assert.equal(bypass.hookSpecificOutput.permissionDecision, 'deny');
  // A subagent's safe call is not waved through by the hook either: it answers nothing, as for the main worker.
  assert.deepEqual(await runHook(fromSubagent('Read', { file_path: `${REPO}/src/app.ts` }, 'explorer')), {});

  // canUseTool hands the policy the tool name and input only (never the agent), so a subagent's call is judged the same.
  const policy = createToolPolicy(guard());
  assert.equal(policy('Bash', { command: 'git push origin main' }).decision, 'ask');
  const read = policy('Read', { file_path: `${REPO}/.env` });
  assert.equal(read.decision === 'ask' && read.category, 'secret');
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
    allowlist: false,
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

// ---------------------------------------------------------------------------------------------
// allowWriteDirs: Foreman's per-task scratch directory and /tmp need no prompt
// ---------------------------------------------------------------------------------------------

test('allowWriteDirs: a plain file in an allowed directory is not an outside_repo hold; everything else outside still is', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fm-guard-allow-'));
  try {
    const scratch = path.join(root, 'scratch', 'task-1');
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(scratch, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(scratch, 'link-out'));
    writeFileSync(path.join(scratch, 'plain.md'), 'x');
    const g = guard({ allowWriteDirs: [scratch, '/tmp'] });
    assert.deepEqual(g.allowWriteDirs, [scratch, '/tmp']);

    const verdictFor = (toolName: string, file_path: string) => classifyToolUse({ toolName, input: { file_path, content: 'x' } }, g);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      assert.deepEqual(verdictFor(tool, path.join(scratch, 'notes.md')), { risky: false }, tool);
      assert.deepEqual(verdictFor(tool, '/tmp/desk-t1-status-filter.md'), { risky: false }, tool);
    }
    assert.deepEqual(classifyToolUse({ toolName: 'NotebookEdit', input: { notebook_path: path.join(scratch, 'n.ipynb') } }, g), { risky: false });
    assert.deepEqual(verdictFor('Write', path.join(scratch, 'plain.md')), { risky: false });
    assert.deepEqual(verdictFor('Write', path.join(scratch, 'deeper', 'new', 'f.md')), { risky: false });

    const held = [
      '/tmp/.env', '/tmp/id_rsa', '/tmp/k.pem', '/tmp/credentials.json', path.join(scratch, '.hidden'), '/tmp/.cache/x.txt',
      '/etc/hosts', '/home/nesar/.bashrc', '/home/nesar/notes.md', '/tmp/../etc/passwd', '/tmp', scratch,
    ];
    for (const target of held) {
      assert.equal(verdictFor('Write', target).risky, true, target);
    }
    assert.equal(verdictFor('Write', '/tmp/.env').risky && (verdictFor('Write', '/tmp/.env') as { category: string }).category, 'secret');
    assert.equal((verdictFor('Write', '/etc/hosts') as { category: string }).category, 'outside_repo');
    // A symlink inside the scratch directory that leads out of it is judged by where it leads (here the only allowed directory is the scratch one).
    // ... and so is a dangling one (its target does not exist yet: a write through it creates the target), a chain of links, and a loop.
    symlinkSync(path.join(elsewhere, 'not-yet.txt'), path.join(scratch, 'dangling-out'));
    symlinkSync(path.join(scratch, 'made-inside.txt'), path.join(scratch, 'dangling-in'));
    symlinkSync(path.join(scratch, 'dangling-out'), path.join(scratch, 'chain-out'));
    symlinkSync(path.join(scratch, 'loop-b'), path.join(scratch, 'loop-a'));
    symlinkSync(path.join(scratch, 'loop-a'), path.join(scratch, 'loop-b'));
    const strict = guard({ allowWriteDirs: [scratch] });
    for (const name of ['dangling-out', 'chain-out', 'loop-a']) {
      const v = classifyToolUse({ toolName: 'Write', input: { file_path: path.join(scratch, name), content: 'x' } }, strict);
      assert.equal(v.risky && v.category, 'outside_repo', name);
    }
    assert.deepEqual(classifyToolUse({ toolName: 'Write', input: { file_path: path.join(scratch, 'dangling-in'), content: 'x' } }, strict), { risky: false });
    const scratchOnly = guard({ allowWriteDirs: [scratch] });
    const viaLink = classifyToolUse({ toolName: 'Write', input: { file_path: path.join(scratch, 'link-out', 'x.txt'), content: 'x' } }, scratchOnly);
    assert.equal(viaLink.risky && viaLink.category, 'outside_repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowWriteDirs: without it every write outside the repo is held, and a directory that holds the home directory is dropped', () => {
  assert.equal(classifyToolUse({ toolName: 'Write', input: { file_path: '/tmp/a.md', content: '' } }, guard()).risky, true);
  assert.deepEqual(guard().allowWriteDirs, []);
  const compiled = compileGuard(config({ allowWriteDirs: ['/', '/home', '/home/nesar', 'relative/dir', '/tmp'] }), REPO, { home: '/home/nesar' });
  assert.deepEqual(compiled.allowWriteDirs, ['/tmp']);
  assert.equal(classifyToolUse({ toolName: 'Write', input: { file_path: '/home/nesar/notes.md', content: '' } }, compiled).risky, true);
  assert.equal(classifyToolUse({ toolName: 'Write', input: { file_path: '/home/nesar/.bashrc', content: '' } }, compiled).risky, true);
});

test('allowWriteDirs: the tool policy and the PreToolUse hook allow a scratch write without a prompt', async () => {
  const g = guard({ allowWriteDirs: ['/tmp/foreman-scratch/task-1', '/tmp'] });
  const policy = createToolPolicy(g);
  assert.deepEqual(policy('Write', { file_path: '/tmp/foreman-scratch/task-1/notes.md', content: 'x' }), { decision: 'allow' });
  assert.equal(policy('Write', { file_path: '/home/nesar/.bashrc', content: 'x' }).decision, 'ask');
  assert.equal(policy('Write', { file_path: '/tmp/.env', content: 'x' }).decision, 'ask');
  const hook = guardHooks(g).PreToolUse[0].hooks[0];
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.md', content: 'x' }, permission_mode: 'default' }), {});
});

test('parseGuardConfig: allowWriteDirs must be a short list of absolute paths, and is optional', () => {
  const body = { enabled: true, riskyPatterns: [], secretPatterns: [] };
  assert.equal(parseGuardConfig(body)?.allowWriteDirs, undefined);
  assert.deepEqual(parseGuardConfig({ ...body, allowWriteDirs: ['/tmp/foreman-scratch/t1', ' /tmp '] })?.allowWriteDirs, ['/tmp/foreman-scratch/t1', '/tmp']);
  for (const bad of ['/tmp', ['relative'], [1], Array.from({ length: 21 }, (_, i) => `/tmp/${i}`)]) {
    assert.throws(() => parseGuardConfig({ ...body, allowWriteDirs: bad }), (error: unknown) => error instanceof AppError && error.statusCode === 400, JSON.stringify(bad));
  }
  assert.equal(parseGuardConfig({ enabled: false, allowWriteDirs: ['/tmp'] })?.allowWriteDirs, undefined);
});

test('allowWriteDirs: a hold made by a guard with an allowlist says so, a guard without one does not', () => {
  const withList = createToolPolicy(guard({ allowWriteDirs: ['/tmp/foreman-scratch/task-1'] }));
  const held = withList('Write', { file_path: '/etc/hosts', content: 'x' });
  assert.equal(held.decision === 'ask' && held.allowlist, true);
  const withoutList = createToolPolicy(guard());
  const heldToo = withoutList('Write', { file_path: '/etc/hosts', content: 'x' });
  assert.equal(heldToo.decision === 'ask' && heldToo.allowlist, false);
  const secret = withList('Write', { file_path: '/tmp/.env', content: 'x' });
  assert.equal(secret.decision === 'ask' && secret.allowlist, true);
});

test('ensureAllowWriteDirs makes the missing directories (mode 0700), leaves existing ones, and never throws', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fm-guard-ensure-'));
  try {
    const scratch = path.join(root, 'foreman-scratch', 'task-9');
    const existing = path.join(root, 'existing');
    mkdirSync(existing);
    const compiled = guard({ allowWriteDirs: [scratch, existing, path.join(root, 'a-file', 'x')] });
    writeFileSync(path.join(root, 'a-file'), 'x');
    const made = ensureAllowWriteDirs(compiled);
    assert.deepEqual(made, [scratch]);
    assert.equal(existsSync(scratch), true);
    assert.equal(statSync(scratch).mode & 0o777, 0o700);
    assert.deepEqual(ensureAllowWriteDirs(compiled), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// referenceDirs: other repositories the session reads and never writes (the donor repos of a parity task)
// ---------------------------------------------------------------------------------------------

test('referenceDirs: read freely (secrets excepted), every write into one is held, in whatever way it is spelled', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fm-guard-ref-'));
  try {
    const repo = path.join(root, 'repo');
    const donor = path.join(root, 'donor');
    const home = path.join(root, 'home');
    for (const d of [repo, path.join(donor, 'internal/ws'), path.join(donor, 'cmd'), path.join(donor, 'frontend'), home]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(path.join(donor, 'internal/ws/ws.go'), 'package ws');
    writeFileSync(path.join(donor, 'cmd/conversation.go'), 'package main');
    writeFileSync(path.join(donor, 'frontend/.env'), 'X=1');
    const g = compileGuard(config({ referenceDirs: [donor, 'relative/dir', '/'], repoRoot: repo, writeOutsideRepo: false }), repo, { home });
    assert.deepEqual(g.referenceDirs, [donor]);
    const run = (command: string) => classifyToolUse(bash(command), g);

    for (const command of [
      `cat ${donor}/cmd/conversation.go | head -3`,
      `sed -n 1,40p ${donor}/cmd/conversation.go`,
      `cd ${donor}; awk '/type .*Hub.* struct/{print FILENAME":"FNR": "$0}' internal/ws/*.go | head`,
      `git -C ${donor} log --oneline -n 5`,
      `grep -rn Hub ${donor}/internal`,
      `find ${donor} -name '*.go'`,
    ]) {
      assert.deepEqual(run(command), { risky: false }, command);
    }
    for (const command of [`cat ${donor}/frontend/.env`, `cd ${donor}/frontend; cat .en*`, `cd ${donor}/frontend; cat *`]) {
      const v = run(command);
      assert.equal(v.risky && v.category, 'secret', command);
    }
    for (const command of [
      `echo x > ${donor}/notes.md`,
      `cd ${donor}/cmd && echo x > new.go`,
      `cp ${repo}/a ${donor}/internal/ws/x.go`,
      `sed -i s/a/b/ ${donor}/cmd/conversation.go`,
      `touch ${donor}/x`,
      `git -C ${donor} pull`,
      `cd ${donor}; git commit -m x`,
      `cd ${donor}; awk '{print > "out.txt"}' cmd/conversation.go`,
    ]) {
      const v = run(command);
      // Writes outside the repo are not held in this guard (writeOutsideRepo is false): only the reference directory holds them.
      assert.equal(v.risky && v.category, 'command', command);
      assert.match(v.risky ? v.matched : '', /reference director|reference repo|in a reference/, command);
    }
    for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const v = classifyToolUse({ toolName, input: { file_path: path.join(donor, 'cmd/conversation.go'), content: 'x' } }, g);
      assert.equal(v.risky && v.category, 'command', toolName);
    }
    assert.deepEqual(classifyToolUse({ toolName: 'Read', input: { file_path: path.join(donor, 'cmd/conversation.go') } }, g), { risky: false });
    assert.deepEqual(classifyToolUse({ toolName: 'Write', input: { file_path: path.join(repo, 'new.ts'), content: 'x' } }, g), { risky: false });
    // The tool policy asks, with the category the hold carries.
    const policy = createToolPolicy(g);
    assert.equal(policy('Write', { file_path: path.join(donor, 'cmd/new.go'), content: 'x' }).decision, 'ask');
    assert.deepEqual(policy('Bash', { command: `cat ${donor}/cmd/conversation.go` }), { decision: 'allow' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('referenceDirs: a find in a command substitution is run and judged by what it prints; a program is not a path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fm-guard-subst-'));
  try {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src/a.ts'), 'sidebarCounts');
    writeFileSync(path.join(repo, 'src/b.tsx'), 'x');
    const g = compileGuard(config({ repoRoot: repo }), repo, { home: path.join(root, 'home') });
    const run = (command: string) => classifyToolUse(bash(command), g);
    // The live desk command: a plain find in a substitution.
    assert.deepEqual(run(`cd ${repo}/src; awk '/sidebar-counts|sidebarCounts/{print FILENAME":"FNR": "$0}' $(find . -name '*.ts' -o -name '*.tsx') | head`), { risky: false });
    // The live libredesk command: .* in an awk regular expression is not a wildcard.
    assert.deepEqual(run(`awk '/type .*Draft.* struct/{p=1} p{print FILENAME":"FNR": "$0} p&&/^}/{p=0}' ${repo}/src/a.ts | head -30`), { risky: false });
    writeFileSync(path.join(repo, 'src/.env'), 'X=1');
    const planted = run(`cd ${repo}/src; awk 1 $(find . -type f)`);
    assert.equal(planted.risky && planted.category, 'secret');
    for (const command of [
      `cd ${repo}/src; cat $(find . -name '*.ts' -exec rm {} +)`,
      `cd ${repo}/src; cat $(find . -fprint ${root}/list)`,
      `cd ${repo}/src; cat $(cat list.txt)`,
      `cd ${repo}/src; cat $(echo a.ts)`,
    ]) {
      assert.equal(run(command).risky, true, command);
    }
    // A key or secret file named as an argument is held; a `.key` property in the code of node -e is not a key file.
    assert.equal(run('cat server.key').risky, true);
    assert.deepEqual(run(`cd ${repo}; node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(b.batches.map(x=>x.key))" src/a.ts`), { risky: false });
    assert.equal(run(`cd ${repo}; node -e "require('fs').writeFileSync('x','y')"`).risky, true);
    assert.equal(run(`cd ${repo}; node -e "require('child_process').execSync('id')"`).risky, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseGuardConfig: referenceDirs must be a short list of absolute paths other than /, and is optional', () => {
  const body = { enabled: true, riskyPatterns: [], secretPatterns: [] };
  assert.equal(parseGuardConfig(body)?.referenceDirs, undefined);
  assert.deepEqual(parseGuardConfig({ ...body, referenceDirs: ['/mnt/dev/moveon/libredesk', ' /mnt/dev/moveon/chatwoot '] })?.referenceDirs, ['/mnt/dev/moveon/libredesk', '/mnt/dev/moveon/chatwoot']);
  for (const bad of ['/mnt/x', ['relative'], ['/'], [1], Array.from({ length: 21 }, (_, i) => `/mnt/${i}`)]) {
    assert.throws(() => parseGuardConfig({ ...body, referenceDirs: bad }), (error: unknown) => error instanceof AppError && error.statusCode === 400, JSON.stringify(bad));
  }
  assert.equal(parseGuardConfig({ enabled: false, referenceDirs: ['/mnt/x'] })?.referenceDirs, undefined);
  // A guard started by an older Foreman (no field) compiles with none.
  assert.deepEqual(guard().referenceDirs, []);
});

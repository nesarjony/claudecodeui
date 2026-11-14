import assert from 'node:assert/strict';
import os from 'node:os';
import test, { after, before } from 'node:test';

import { parseSandboxPolicy, type ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import type { ForemanSandboxScope } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { SAMPLE_SCOPE, samplePolicy } from './foreman-sandbox-support.js';

/**
 * What a policy may open up, field by field: each table lists values that are accepted and values that are refused (400 SANDBOX_INVALID,
 * with a message naming the field). The home directory, cloudcli's port, claude-cap's URL and the token files are pinned for the file; the
 * session works in /mnt/dev/repo unless a table says otherwise.
 */

const pinned = {
  HOME: '/home/worker',
  SERVER_PORT: '3011',
  CLAUDE_CAP_URL: 'http://127.0.0.1:34817',
  FOREMAN_BRIDGE_TOKEN_FILE: '/mnt/dev/secrets/bridge-token',
  FOREMAN_EVENTS_TOKEN_FILE: '/srv/foreman/tokens/intake',
} as const;
const saved = Object.fromEntries(Object.keys(pinned).map((name) => [name, process.env[name]]));
before(() => Object.assign(process.env, pinned));
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SCRATCH = '/mnt/dev/scratch/batch-1';

/** Checks every row of `table`: `make` turns its value into a policy, which must be accepted or refused naming `field` for a session in `scope`. */
function verdicts(field: string, make: (value: string) => ForemanSandboxPolicy, table: Array<[string, boolean]>, scope: ForemanSandboxScope = SAMPLE_SCOPE): void {
  for (const [value, accepted] of table) {
    const raw: unknown = JSON.parse(JSON.stringify(make(value)));
    if (accepted) {
      assert.doesNotThrow(() => parseSandboxPolicy(raw, scope), `${field}: ${value} should be accepted`);
      continue;
    }
    assert.throws(
      () => parseSandboxPolicy(raw, scope),
      (error: unknown) => error instanceof AppError && error.code === 'SANDBOX_INVALID' && error.statusCode === 400 && error.message.includes(field),
      `${field}: ${value} should be refused`,
    );
  }
}

test('env: only the listed variables, and the temp directories inside scratchDir', () => {
  const withVariable = (entry: string) => {
    const [name, value] = entry.split('=');
    return samplePolicy({ env: { TMPDIR: `${SCRATCH}/tmp`, [name]: value } });
  };
  verdicts('env', withVariable, [
    [`TMPDIR=${SCRATCH}/tmp`, true],
    [`CLAUDE_CODE_TMPDIR=${SCRATCH}/cc`, true],
    [`TMPDIR=${SCRATCH}`, true],
    ['CI=1', true],
    ['NODE_ENV=test', true],
    ['TZ=UTC', true],
    ['LANG=C.UTF-8', true],
    ['LC_ALL=C', true],
    ['GIT_AUTHOR_NAME=Worker', true],
    ['GIT_AUTHOR_EMAIL=worker@example.com', true],
    ['GIT_COMMITTER_NAME=Worker', true],
    ['GIT_COMMITTER_EMAIL=worker@example.com', true],
    ['NODE_OPTIONS=--require /tmp/x.js', false],
    ['LD_PRELOAD=/tmp/x.so', false],
    ['ANTHROPIC_BASE_URL=http://127.0.0.1:9', false],
    ['ANTHROPIC_API_KEY=sk-test', false],
    ['CLAUDE_CONFIG_DIR=/mnt/dev/x/y', false],
    ['PATH=/tmp/bin', false],
    ['HOME=/mnt/dev/x/y', false],
    ['TMPDIR=/tmp', false],
    [`TMPDIR=${SCRATCH}-other/tmp`, false],
    [`TMPDIR=${SCRATCH}/../x`, false],
    ['CLAUDE_CODE_TMPDIR=/home/worker/.claude', false],
  ]);
});

test('network.allowedDomains: host:port only, never localhost, never the port of cloudcli or claude-cap', () => {
  verdicts('network.allowedDomains', (entry) => samplePolicy({ network: { allowedDomains: [entry], allowAllUnixSockets: true } }), [
    ['registry.npmjs.org:443', true],
    ['github.com:22', true],
    ['10.0.0.5:8080', true],
    ['[2001:db8::1]:443', true],
    ['github.com', false],
    ['*.github.com:443', false],
    ['http://github.com:443', false],
    ['github.com:0', false],
    ['github.com:70000', false],
    ['localhost:8080', false],
    ['LOCALHOST:8080', false],
    ['api.localhost:80', false],
    ['127.0.0.1:3001', false],
    ['127.0.0.1:3011', false],
    ['127.0.0.1:34817', false],
    ['192.168.1.10:34817', false],
    ['[::1]:3001', false],
    ['rebind.example.com:3011', false],
  ]);
});

const pathRows = (write: boolean): Array<[string, boolean]> => [
  ['/mnt/dev/repo', true],
  ['/mnt/dev/repo/.git', true],
  ['/home/worker/.cache/npm', !write],
  ['/', false],
  ['/mnt', false],
  ['/mnt/dev', false],
  ['/home', false],
  ['/home/worker', false],
  ['/home/worker/', false],
  ['mnt/dev/repo', false],
  ['/mnt/dev/../etc/x', false],
  ['/mnt/dev//repo', false],
  ['/mnt/dev/repo/*', false],
  ['/home/worker/.claude', false],
  ['/home/worker/.ssh', false],
  ['/mnt/dev/repo/.claude/settings.json', !write],
  ['/mnt/dev/repo/.git/hooks', !write],
  ['/mnt/dev/repo/.git/hooks/pre-commit', !write],
  ['/mnt/dev/repo/.git/config', !write],
];

const readable = (entry: string) => samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowRead: [entry] } });
const writable = (entry: string) => samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowWrite: [entry] } });

test('filesystem.allowRead and allowWrite: absolute, normalised, deep enough, never the home directory; nothing writable that runs code', () => {
  verdicts('filesystem.allowRead', readable, pathRows(false));
  verdicts('filesystem.allowWrite', writable, pathRows(true));
});

test('filesystem.allowWrite: only the project, scratchDir and the git directory, and what lies inside them', () => {
  // A linked worktree: the repository's git directory lies outside the checkout.
  const worktree = { projectPath: '/mnt/dev/repo-wt/task-9', gitCommonDir: '/mnt/dev/repo/.git' };
  verdicts('filesystem.allowWrite', writable, [
    ['/mnt/dev/repo-wt/task-9', true],
    ['/mnt/dev/repo-wt/task-9/src', true],
    ['/mnt/dev/scratch/batch-1', true],
    ['/mnt/dev/scratch/batch-1/npm-cache', true],
    ['/mnt/dev/repo/.git', true],
    ['/mnt/dev/repo/.git/objects', true],
    ['/mnt/dev/repo', false],
    ['/mnt/dev/repo-wt/task-90', false],
    ['/mnt/dev/repo-wt', false],
    ['/mnt/dev/scratch/batch-10', false],
    ['/home/worker/.gitconfig', false],
    ['/home/worker/.bashrc', false],
    ['/home/worker/.cache/pip', false],
    ['/home/worker/.local/bin', false],
    ['/usr/local/bin', false],
  ], worktree);
  // No repository: no git directory to write.
  verdicts('filesystem.allowWrite', writable, [['/mnt/dev/repo-wt/task-9', true], ['/mnt/dev/repo/.git', false]], { ...worktree, gitCommonDir: null });
  // A project that is a whole tree of the host (the home directory, or shallower than three components) makes nothing writable in it.
  verdicts('filesystem.allowWrite', writable, [['/home/worker/.bashrc', false], ['/home/worker/code/x', false], ['/mnt/dev/scratch/batch-1', true]], { projectPath: '/home/worker', gitCommonDir: null });
  verdicts('filesystem.allowWrite', writable, [['/mnt/dev/repo', false]], { projectPath: '/mnt/dev', gitCommonDir: null });
});

test('the file tools\' write rules are held to the same places; a read rule reaches no secret', () => {
  verdicts('permissions.allow', (rule) => samplePolicy({ permissions: { allow: [rule], deny: [] } }), [
    ['Edit(//mnt/dev/repo/**)', true],
    ['Write(//mnt/dev/repo/.git/objects/**)', true],
    ['NotebookEdit(//mnt/dev/scratch/batch-1/**)', true],
    ['Edit(//mnt/dev/other/**)', false],
    ['Edit(//mnt/dev/repo-other/**)', false],
    ['Write(//home/worker/.bashrc)', false],
    ['Write(//home/worker/.gitconfig)', false],
    ['Read(//usr/**)', true],
    ['Read(//home/**)', false],
    ['Read(//home/worker/.ssh/**)', false],
    ['Read(//home/worker/.config/foreman/bridge-token)', false],
    ['Read(//etc/**)', false],
    ['Read(//mnt/dev/secrets/**)', false],
  ]);
});

test('no secret is readable or writable: the owner\'s credentials and settings in either home, claude-cap\'s keys and the token files', () => {
  const passwdHome = os.userInfo().homedir;
  const secretRows: Array<[string, boolean]> = [
    ['/home/worker/.claude.json', false],
    ['/home/worker/.config', false],
    ['/home/worker/.config/foreman', false],
    ['/home/worker/.aws/credentials', false],
    ['/home/worker/.gnupg', false],
    ['/home/worker/.docker', false],
    ['/home/worker/.kube/config', false],
    ['/home/worker/.git-credentials', false],
    ['/home/worker/.cloudcli/assets', false],
    ['/home/worker/.claude-code-ui', false],
    [`${passwdHome}/.ssh`, false],
    [`${passwdHome}/.config/foreman`, false],
    ['/etc/claude-cap.env', false],
    ['/mnt/dev/secrets', false],
    ['/mnt/dev/secrets/bridge-token', false],
    ['/srv/foreman/tokens', false],
    ['/srv/foreman/tokens/intake', false],
    ['/home/worker/.cache/npm', true],
    ['/mnt/dev/repo', true],
  ];
  verdicts('filesystem.allowRead', readable, secretRows);
  verdicts('filesystem.allowWrite', writable, secretRows.filter(([, accepted]) => !accepted));
  verdicts('scratchDir', (scratchDir) => samplePolicy({ scratchDir }), [['/home/worker/.config/scratch', false], ['/srv/foreman/tokens', false]]);
});

test('scratchDir is held to the rules of a writable path', () => {
  verdicts('scratchDir', (scratchDir) => samplePolicy({ scratchDir }), [
    ['/mnt/dev/scratch/batch-1', true],
    ['/mnt/dev/fs', true],
    ['/mnt/dev', false],
    ['/home/worker', false],
    ['/home/worker/.claude/x', false],
    ['/mnt/dev/scratch/../batch', false],
  ]);
});

test('permissions.allow: Bash, TodoWrite, the infigraph MCP server and file rules on an absolute path, nothing else', () => {
  verdicts('permissions.allow', (rule) => samplePolicy({ permissions: { allow: [rule], deny: [] } }), [
    ['Bash', true],
    ['Bash(*)', true],
    ['TodoWrite', true],
    ['mcp__infigraph', true],
    ['mcp__infigraph__save_session', true],
    ['Read(//usr)', true],
    ['Read(//usr/**)', true],
    ['Read(//mnt/dev/repo/**)', true],
    ['Edit(//mnt/dev/repo/**)', true],
    ['Write(//mnt/dev/scratch/batch-1/**)', true],
    ['NotebookEdit(//mnt/dev/repo/**)', true],
    ['Read', false],
    ['Edit', false],
    ['Write', false],
    ['NotebookEdit', false],
    ['WebFetch', false],
    ['WebSearch', false],
    ['Task', false],
    ['Bash(git push:*)', false],
    ['mcp__github', false],
    ['mcp__infigraphx', false],
    ['Read(//**)', false],
    ['Read(//**/.env)', false],
    ['Read(**)', false],
    ['Read(src/**)', false],
    ['Read(/mnt/dev/repo/**)', false],
    ['Read(//mnt/dev/../etc/**)', false],
    ['Edit(//mnt/**)', false],
    ['Edit(//mnt/dev/*/x)', false],
    ['Edit(//home/worker/**)', false],
    ['Edit(//home/worker/.claude/**)', false],
    ['Write(//home/worker/.ssh/authorized_keys)', false],
    ['Edit(//mnt/dev/repo/.git/hooks/**)', false],
    ['Write(//mnt/dev/repo/.git/config)', false],
  ]);
});

test('a refusal says which field and value were too wide, and approvalTimeoutMs keeps its bounds', () => {
  assert.throws(
    () => parseSandboxPolicy(JSON.parse(JSON.stringify(samplePolicy({ env: { NODE_OPTIONS: '--inspect' } }))), SAMPLE_SCOPE),
    /sandbox would widen the session: env\.NODE_OPTIONS is not a variable a policy may set/,
  );
  for (const approvalTimeoutMs of [999, 24 * 60 * 60 * 1000 + 1]) {
    assert.throws(() => parseSandboxPolicy({ ...samplePolicy(), approvalTimeoutMs }, SAMPLE_SCOPE), /approvalTimeoutMs/);
  }
});

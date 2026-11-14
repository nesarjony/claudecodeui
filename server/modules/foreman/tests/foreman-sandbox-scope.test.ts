import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { parseSandboxPolicy, type ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import { AppError } from '@/shared/utils.js';

import { samplePolicy } from './foreman-sandbox-support.js';

/**
 * What a policy may open up, field by field: each table lists values that are accepted and values that are refused (400 SANDBOX_INVALID,
 * with a message naming the field). The home directory, cloudcli's port and claude-cap's URL are pinned for the file.
 */

const pinned = { HOME: '/home/worker', SERVER_PORT: '3011', CLAUDE_CAP_URL: 'http://127.0.0.1:34817' } as const;
const saved = Object.fromEntries(Object.keys(pinned).map((name) => [name, process.env[name]]));
before(() => Object.assign(process.env, pinned));
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SCRATCH = '/mnt/dev/scratch/batch-1';

/** Checks every row of `table`: `make` turns its value into a policy, which must be accepted or refused naming `field`. */
function verdicts(field: string, make: (value: string) => ForemanSandboxPolicy, table: Array<[string, boolean]>): void {
  for (const [value, accepted] of table) {
    const raw: unknown = JSON.parse(JSON.stringify(make(value)));
    if (accepted) {
      assert.doesNotThrow(() => parseSandboxPolicy(raw), `${field}: ${value} should be accepted`);
      continue;
    }
    assert.throws(
      () => parseSandboxPolicy(raw),
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
  ['/home/worker/.cache/npm', true],
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
  ['/home/worker/.claude', !write],
  ['/home/worker/.ssh', !write],
  ['/mnt/dev/repo/.claude/settings.json', !write],
  ['/mnt/dev/repo/.git/hooks', !write],
  ['/mnt/dev/repo/.git/hooks/pre-commit', !write],
  ['/mnt/dev/repo/.git/config', !write],
];

test('filesystem.allowRead and allowWrite: absolute, normalised, deep enough, never the home directory; nothing writable that runs code', () => {
  verdicts('filesystem.allowRead', (entry) => samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowRead: [entry] } }), pathRows(false));
  verdicts('filesystem.allowWrite', (entry) => samplePolicy({ filesystem: { ...samplePolicy().filesystem, allowWrite: [entry] } }), pathRows(true));
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
    () => parseSandboxPolicy(JSON.parse(JSON.stringify(samplePolicy({ env: { NODE_OPTIONS: '--inspect' } })))),
    /sandbox would widen the session: env\.NODE_OPTIONS is not a variable a policy may set/,
  );
  for (const approvalTimeoutMs of [999, 24 * 60 * 60 * 1000 + 1]) {
    assert.throws(() => parseSandboxPolicy({ ...samplePolicy(), approvalTimeoutMs }), /approvalTimeoutMs/);
  }
});

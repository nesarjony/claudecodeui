// The policies cloudcli refuses at a session start, tried against the real bridge: each must be a 400 that names what is wrong, and nothing may start.
import { SCRATCH, WT } from './battery-lab.mts';
import { bridge, CONFIG_DIR, INSTANCE_HOME, instanceDbCount, newKey, REAL_HOME, type SandboxPolicy } from './lib.mts';

type StartBody = Record<string, unknown> & { sandbox?: SandboxPolicy; permissionMode?: string };
type RefusalCase = { name: string; expect: string; change: (body: StartBody) => void };
export type RefusalResult = { name: string; expect: string; status: number; code: string; message: string; nothingStarted: boolean; held: boolean };

const sandboxCase = (name: string, change: (policy: SandboxPolicy) => void): RefusalCase => ({
  name,
  expect: 'SANDBOX_INVALID',
  change: (body) => {
    if (body.sandbox) change(body.sandbox);
  },
});

function cases(): RefusalCase[] {
  const homes: Array<[string, string]> = [['HOME (the instance\'s)', INSTANCE_HOME], ['the passwd home', REAL_HOME]];
  const longScratch = `${SCRATCH}/${'x'.repeat(64 - SCRATCH.length)}`;
  return [
    ...homes.flatMap(([which, home]) => [
      sandboxCase(`allowWrite ${which}/.bashrc`, (policy) => { policy.filesystem.allowWrite.push(`${home}/.bashrc`); }),
      sandboxCase(`allowWrite ${which}/.gitconfig`, (policy) => { policy.filesystem.allowWrite.push(`${home}/.gitconfig`); }),
      sandboxCase(`allowRead ${which}/.claude`, (policy) => { policy.filesystem.allowRead.push(`${home}/.claude`); }),
      sandboxCase(`allowRead ${which}/.config`, (policy) => { policy.filesystem.allowRead.push(`${home}/.config`); }),
      sandboxCase(`allowRead ${which}/.ssh`, (policy) => { policy.filesystem.allowRead.push(`${home}/.ssh`); }),
    ]),
    sandboxCase('allowRead the bridge token file', (policy) => { policy.filesystem.allowRead.push(`${CONFIG_DIR}/bridge-token`); }),
    sandboxCase('allowRead the intake token file', (policy) => { policy.filesystem.allowRead.push(`${CONFIG_DIR}/intake-token`); }),
    sandboxCase('Read rule on the bridge token file', (policy) => { policy.permissions.allow.push(`Read(/${CONFIG_DIR}/bridge-token)`); }),
    sandboxCase('env NODE_OPTIONS', (policy) => { policy.env.NODE_OPTIONS = '--require /mnt/dev/sbx-lab-s3a/evil.js'; }),
    sandboxCase('env LD_PRELOAD', (policy) => { policy.env.LD_PRELOAD = '/mnt/dev/sbx-lab-s3a/evil.so'; }),
    sandboxCase('env ANTHROPIC_BASE_URL', (policy) => { policy.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/'; }),
    sandboxCase('allowedDomains 127.0.0.1:3001 (live cloudcli)', (policy) => { policy.network.allowedDomains.push('127.0.0.1:3001'); }),
    sandboxCase('allowedDomains 127.0.0.1:3011 (this instance)', (policy) => { policy.network.allowedDomains.push('127.0.0.1:3011'); }),
    sandboxCase('allowedDomains 127.0.0.1:34817 (claude-cap)', (policy) => { policy.network.allowedDomains.push('127.0.0.1:34817'); }),
    sandboxCase('allowedDomains *', (policy) => { policy.network.allowedDomains.push('*'); }),
    sandboxCase('allowedDomains example.com (no port)', (policy) => { policy.network.allowedDomains.push('example.com'); }),
    sandboxCase(`scratchDir of ${longScratch.length} characters`, (policy) => {
      policy.scratchDir = longScratch;
      policy.env = { ...policy.env, TMPDIR: `${longScratch}/tmp`, CLAUDE_CODE_TMPDIR: `${longScratch}/cc` };
    }),
    { name: 'permissionMode bypassPermissions', expect: 'PERMISSION_MODE_FORBIDDEN', change: (body) => { body.permissionMode = 'bypassPermissions'; } },
    { name: 'permissionMode auto', expect: 'PERMISSION_MODE_FORBIDDEN', change: (body) => { body.permissionMode = 'auto'; } },
    { name: 'no sandbox', expect: 'SANDBOX_REQUIRED', change: (body) => { delete body.sandbox; } },
  ];
}

/** What a start leaves behind in the instance: sessions (the database and the bridge's list), their states, the stored keys and events. */
async function footprint(): Promise<string> {
  const listed = ((await bridge('GET', '/sessions?limit=100')).body.data.sessions as unknown[]).length;
  const tables = ['sessions', 'foreman_session_state', 'foreman_idempotency', 'foreman_events'].map((table) => `${table} ${instanceDbCount(`select count(*) from ${table}`)}`);
  return [...tables, `listed ${listed}`].join(', ');
}

/** Tries every case with `policy` (a policy cloudcli accepts) as the base. A start that is wrongly accepted is interrupted at once. */
export async function runRefusals(policy: SandboxPolicy): Promise<RefusalResult[]> {
  const results: RefusalResult[] = [];
  for (const refusal of cases()) {
    const body: StartBody = { projectPath: WT, prompt: 'refusal check', model: 'claude-sonnet-5-5', billing: 'cap', permissionMode: 'default', sandbox: structuredClone(policy), idempotencyKey: newKey('refusal') };
    refusal.change(body);
    const before = await footprint();
    const answer = await bridge('POST', '/sessions', body);
    if (answer.status === 201) {
      await bridge('POST', `/sessions/${answer.body.data.sessionId as string}/interrupt`, { idempotencyKey: newKey('refusal-interrupt') });
    }
    const after = await footprint();
    const code = answer.body.error?.code ?? `started ${answer.body.data?.sessionId ?? ''}`;
    results.push({
      name: refusal.name,
      expect: refusal.expect,
      status: answer.status,
      code,
      message: String(answer.body.error?.message ?? '').slice(0, 220),
      nothingStarted: before === after,
      held: answer.status === 400 && code === refusal.expect && before === after,
    });
  }
  return results;
}

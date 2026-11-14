import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';

/** A complete policy of the shape Foreman sends, small enough to read in a test; the temp directories follow the scratch directory. */
export function samplePolicy(overrides: Partial<ForemanSandboxPolicy> = {}): ForemanSandboxPolicy {
  const scratchDir = overrides.scratchDir ?? '/mnt/dev/scratch/batch-1';
  return {
    scratchDir,
    approvalTimeoutMs: 120_000,
    network: { allowedDomains: ['registry.npmjs.org:443'], allowAllUnixSockets: true },
    filesystem: {
      denyRead: ['/home', '/mnt', '/tmp', '/mnt/dev/repo/**/.env*'],
      allowRead: ['/mnt/dev/scratch/batch-1'],
      allowWrite: ['/mnt/dev/scratch/batch-1'],
      denyWrite: ['/mnt/dev/repo/.git/hooks'],
    },
    credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] },
    permissions: { allow: ['Bash', 'Edit(//mnt/dev/repo/**)'], deny: ['Read(~/.ssh/**)', 'Write(//mnt/dev/repo/.git/**)'] },
    disallowedTools: ['AskUserQuestion', 'WebFetch'],
    env: { TMPDIR: `${scratchDir}/tmp`, CLAUDE_CODE_TMPDIR: `${scratchDir}/cc` },
    ...overrides,
  };
}

import type { ForemanSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import type { ForemanSandboxScope } from '@/shared/types.js';

/** Where the sample policy's session works when a test checks a policy on its own: a repository at /mnt/dev/repo. */
export const SAMPLE_SCOPE: ForemanSandboxScope = { projectPath: '/mnt/dev/repo', gitCommonDir: '/mnt/dev/repo/.git' };

/**
 * A complete policy of the shape Foreman sends, small enough to read in a test. What it reads, writes and edits is its scratch directory, so
 * it fits any project; the temp directories follow the scratch directory.
 */
export function samplePolicy(overrides: Partial<ForemanSandboxPolicy> = {}): ForemanSandboxPolicy {
  const scratchDir = overrides.scratchDir ?? '/mnt/dev/scratch/batch-1';
  return {
    scratchDir,
    approvalTimeoutMs: 120_000,
    network: { allowedDomains: ['registry.npmjs.org:443'], allowAllUnixSockets: true },
    filesystem: {
      denyRead: ['/home', '/mnt', '/tmp', '/mnt/dev/repo/**/.env*'],
      allowRead: [scratchDir],
      allowWrite: [scratchDir],
      denyWrite: ['/mnt/dev/repo/.git/hooks'],
    },
    credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] },
    permissions: { allow: ['Bash', `Edit(/${scratchDir}/**)`], deny: ['Read(~/.ssh/**)', 'Write(//mnt/dev/repo/.git/**)'] },
    disallowedTools: ['AskUserQuestion', 'WebFetch'],
    env: { TMPDIR: `${scratchDir}/tmp`, CLAUDE_CODE_TMPDIR: `${scratchDir}/cc` },
    ...overrides,
  };
}

/** A sandbox as the session state records it: the sample policy with the sample scope. */
export const sampleSandbox = (overrides: Partial<ForemanSandboxPolicy> = {}) => ({ policy: samplePolicy(overrides), scope: SAMPLE_SCOPE });

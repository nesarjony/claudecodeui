// Which sandbox policy lets a worktree's session write its git directory (the main repository's .git) while hooks and config stay read-only?
import { startFakeApi } from './fake-model-api.mjs';
import { bridge, buildPolicy, instance, newKey, waitFor } from './lib.mts';

const LAB = '/mnt/dev/sbx-lab-s3a';
const REPO = `${LAB}/repo`;
const WT = `${LAB}/wt`;
const SCRATCH = `${LAB}/scratch`;
const git = `${REPO}/.git`;
const steps = [
  `touch ${git}/objects/probe && echo objects-writable || echo objects-ro`,
  `touch ${git}/worktrees/wt/probe && echo wtdir-writable || echo wtdir-ro`,
  `touch ${git}/hooks/probe && echo hooks-writable || echo hooks-ro`,
  `cd ${WT} && echo x > c.txt && git add -- c.txt && git commit -q -m probe -- c.txt; echo commit-rc=$?; git log -1 --format=%s`,
  `echo evil > ${git}/config 2>&1; echo config-rc=$?; touch ${git}/hooks/pre-commit 2>&1; echo hooks-rc=$?`,
];
type Policy = Awaited<ReturnType<typeof buildPolicy>>;
const variants: Array<[string, (policy: Policy) => void]> = [
  ['as built', () => undefined],
  ['no denyWrite for hooks/config', (p) => { p.filesystem.denyWrite = p.filesystem.denyWrite.filter((entry: string) => !entry.startsWith(git)); }],
  ['git dir only in allowWrite, not allowRead', (p) => { p.filesystem.allowRead = p.filesystem.allowRead.filter((entry: string) => entry !== git); }],
  ['neither denyWrite nor allowRead for it', (p) => { p.filesystem.denyWrite = p.filesystem.denyWrite.filter((entry: string) => !entry.startsWith(git)); p.filesystem.allowRead = p.filesystem.allowRead.filter((entry: string) => entry !== git); }],
  ['subdirectories only: objects, refs, logs, worktrees/wt (read-only .git around them)', (p) => {
    p.filesystem.denyWrite = p.filesystem.denyWrite.filter((entry: string) => !entry.startsWith(git));
    p.filesystem.allowWrite = [...p.filesystem.allowWrite.filter((entry: string) => entry !== git), `${git}/objects`, `${git}/refs`, `${git}/logs`, `${git}/worktrees/wt`];
  }],
  ['whole main checkout writable', (p) => { p.filesystem.allowWrite = [...p.filesystem.allowWrite, REPO]; p.filesystem.allowRead = [...p.filesystem.allowRead, REPO]; }],
];
const only = process.argv[2];
for (const [name, mutate] of variants) {
  if (only && !name.startsWith(only)) continue;
  const fake = await startFakeApi(steps.map((command) => ({ tool: 'Bash', input: { command } })), { port: 3012 });
  try {
    if (name === variants[0]?.[0]) instance(['restart'], { CLAUDE_CAP_URL: fake.url });
    const policy = await buildPolicy({ cwd: WT, scratch: SCRATCH, gitCommonDir: git });
    mutate(policy);
    const started = await bridge('POST', '/sessions', { projectPath: WT, prompt: 'go', model: 'claude-sonnet-5-5', billing: 'cap', sandbox: policy, idempotencyKey: newKey('gitprobe') });
    const id = started.body.data.sessionId as string;
    await waitFor('end', async () => ((await bridge('GET', `/sessions/${id}/events?after=0`)).body.data.events as any[]).some((e) => e.kind === 'turn_end' || e.kind === 'error') || null, 120_000, 1000);
    console.log(`== ${name}`);
    for (const r of fake.results()) console.log('  ', JSON.stringify(r.text.replace(/<system-reminder>[\s\S]*$/, '').trim().slice(0, 400)));
  } finally {
    await fake.close();
  }
}

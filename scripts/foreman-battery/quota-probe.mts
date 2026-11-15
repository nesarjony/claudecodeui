// A worker whose profile is over its quota: claude-cap answers every request with 429 `profile_quota`.
//   node --import tsx scripts/foreman-battery/quota-probe.mts [cap_reached|usage_unknown]
// Checks what the bridge makes of it: a `quota` event (not an `error`) carrying the reset time, and a session that stays usable.
import { execSync } from 'node:child_process';

import { startFakeApi } from './fake-model-api.mjs';
import { bridge, buildPolicy, instance, newKey, waitFor } from './lib.mts';

const reason = process.argv[2] === 'usage_unknown' ? 'usage_unknown' : 'cap_reached';
const LAB = '/mnt/dev/sbx-lab-s3a';
const REPO = `${LAB}/repo`;
const WT = `${LAB}/wt-quota`;
const SCRATCH = `${LAB}/scratch-quota`;
const sh = (command: string) => execSync(command, { encoding: 'utf8' }).trim();
sh(`mkdir -p ${SCRATCH}/tmp ${SCRATCH}/cc; git -C ${REPO} worktree remove --force ${WT} 2>/dev/null; rm -rf ${WT}; git -C ${REPO} worktree prune; git -C ${REPO} worktree add -q -B quota ${WT}`);

const resetAt = reason === 'cap_reached' ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
const fakeModel = await startFakeApi([], { port: 3012, quota: { reason, resetAt, retryAfter: 1, message: `Profile "foreman-worker" ${reason === 'cap_reached' ? 'has used its share of the "minimax" plan (fiveHour 72% >= cap 70%)' : 'is capped but its usage is unknown'}.` } });
const startedAt = Date.now();
try {
  instance(['restart'], { CLAUDE_CAP_URL: fakeModel.url });
  instance(['register-project', WT]);
  const started = await bridge('POST', '/sessions', { projectPath: WT, prompt: 'say hello', model: 'claude-sonnet-5-5', billing: 'cap', taskId: 'quota-probe', sandbox: await buildPolicy({ cwd: WT, scratch: SCRATCH, gitCommonDir: `${REPO}/.git` }), idempotencyKey: newKey('quota-start') });
  if (started.status !== 201) throw new Error(`start refused: ${JSON.stringify(started.body)}`);
  const sessionId = started.body.data.sessionId as string;
  const events = await waitFor('an event that ends the turn', async () => {
    const all = (await bridge('GET', `/sessions/${sessionId}/events?after=0`)).body.data.events as any[];
    return all.some((event) => ['quota', 'error', 'turn_end', 'session_end'].includes(event.kind)) ? all : null;
  }, 8 * 60_000, 1000);
  const state = (await bridge('GET', `/sessions/${sessionId}/state`)).body.data;
  console.log(JSON.stringify({ reason, secondsToEvent: Math.round((Date.now() - startedAt) / 1000), state, events: events.map((event) => ({ id: event.id, kind: event.kind, payload: event.payload })), requestPaths: fakeModel.requestPaths(), modelRequests: fakeModel.stats() }, null, 2));
} finally {
  await fakeModel.close();
  instance(['restart']);
}

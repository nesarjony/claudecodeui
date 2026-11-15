// One real worker: a sandboxed session on a worktree of the scratch repo, answered by MiniMax through claude-cap's foreman-worker profile.
//   node --import tsx scripts/foreman-battery/worker-smoke.mts
// It checks the whole bridge path with a real model: the start with a policy, the events (ids, sequences, the model and the commits of the
// turn) pushed with the intake token to a stand-in intake, `eventsSince`, and which model answered. A Claude model anywhere is a leak: the script stops and says so.
import { execFileSync } from 'node:child_process';
import http from 'node:http';

import { bridge, buildPolicy, instance, minimaxWindows, newKey, secret, waitFor } from './lib.mts';

const SCRATCH_REPO = '/mnt/dev/frontend/foreman-scratch';
const INTAKE_PORT = 4299;
const received: Array<{ authorization: string | undefined; event: any }> = [];
const intake = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ authorization: request.headers.authorization, event: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200).end('{}');
  });
});
await new Promise<void>((resolve) => intake.listen(INTAKE_PORT, '127.0.0.1', resolve));

const before = await minimaxWindows();
instance(['restart'], { FOREMAN_EVENTS_URL: `http://127.0.0.1:${INTAKE_PORT}/events` });
instance(['register-project', SCRATCH_REPO]);

const id = Date.now().toString(36);
const branch = `foreman/smoke-${id}`;
const worktree = (await bridge('POST', '/projects/worktree', { projectPath: SCRATCH_REPO, branch })).body.data.path as string;
// Short: the CLI's bridge socket lives under it and a unix socket path is limited to 107 bytes (cloudcli refuses a scratch directory over 64 characters).
const scratch = `/mnt/dev/fscratch/${id}/s`;
const brief = [
  `You work in ${worktree}, a TypeScript library. Do exactly this, nothing else:`,
  '1. Create src/capitalize.ts exporting capitalize(text: string): string, which upper-cases the first character and leaves the rest as it is ("" stays "").',
  '2. Create test/capitalize.test.ts with node:test and node:assert/strict (import from "../src/capitalize.ts") covering "hello", "" and "élan".',
  '3. Run `node --test test/capitalize.test.ts` and make it pass.',
  '4. Stage the two files by name (never `git add -A`) and commit them with a message whose last line is the trailer `Foreman-Batch: smoke-1`.',
  'Your last message must end with a line that is exactly: FOREMAN-RESULT: done',
].join('\n');

const started = await bridge('POST', '/sessions', {
  projectPath: worktree,
  prompt: brief,
  model: 'claude-sonnet-5-5',
  billing: 'cap',
  taskId: 'smoke-1',
  sandbox: await buildPolicy({ cwd: worktree, scratch, gitCommonDir: `${SCRATCH_REPO}/.git` }),
  idempotencyKey: newKey('smoke-start'),
});
if (started.status !== 201) throw new Error(`start refused: ${JSON.stringify(started.body)}`);
const sessionId = started.body.data.sessionId as string;
console.log(`session ${sessionId} in ${worktree}`);

const leak = (events: any[]) => events.find((event) => event.kind === 'turn_end' && /claude/i.test(String(event.payload.model)));
const events = await waitFor('the worker to claim done', async () => {
  const all = (await bridge('GET', `/sessions/${sessionId}/events?after=0`)).body.data.events as any[];
  if (leak(all)) throw new Error(`LEAK: a turn reports the Claude model ${leak(all).payload.model}`);
  for (const ask of all.filter((event) => event.kind === 'permission_request')) {
    // A prompt the sandbox did not settle is the supervisor's to answer; this stand-in supervisor refuses.
    await bridge('POST', `/sessions/${sessionId}/permission`, { requestId: ask.payload.requestId, decision: 'deny', idempotencyKey: `deny:${ask.id}` });
  }
  return all.some((event) => event.kind === 'turn_end' && event.payload.claimsDone) || all.some((event) => event.kind === 'error' || event.kind === 'session_end') ? all : null;
}, 8 * 60_000, 2000);

// The stand-in may also hear older sessions' events that an earlier run left owed: that is the push surviving restarts, and not this session's.
const mine = () => received.filter((entry) => entry.event.sessionId === sessionId);
await waitFor('the pushes to be acknowledged', async () => mine().length >= events.length, 30_000);
const state = (await bridge('GET', `/sessions/${sessionId}/state`)).body.data;
const log = execFileSync('git', ['-C', worktree, 'log', '--format=%h %s%n%b', 'main..HEAD'], { encoding: 'utf8' }).trim();
const after = await minimaxWindows();

console.log(JSON.stringify({
  state,
  events: events.map((event) => ({ id: event.id, kind: event.kind, ...(event.kind === 'turn_end' ? { model: event.payload.model, commitCount: event.payload.commitCount, claimsDone: event.payload.claimsDone, usage: event.payload.usage } : {}), ...(event.kind === 'error' ? { message: event.payload.message } : {}) })),
  pushed: mine().length,
  pushedWithIntakeToken: mine().every((entry) => entry.authorization === `Bearer ${secret('intake-token')}`),
  pushedEqualsStored: JSON.stringify(mine().map((entry) => entry.event.id)) === JSON.stringify(events.map((event) => event.id)),
  olderEventsDeliveredLate: received.length - mine().length,
  commits: log,
  minimax: { before, after },
}, null, 2));
intake.close();
instance(['restart']);

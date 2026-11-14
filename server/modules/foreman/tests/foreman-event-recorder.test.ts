import assert from 'node:assert/strict';
import test from 'node:test';

import { createForemanEventRecorder } from '@/modules/foreman/foreman-event-recorder.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import { makeStore } from './foreman-pipeline-support.js';

const base = { sessionId: 'sess-1', projectPath: '/mnt/dev/repo' };
const turnEnd = (text = 'Row done.'): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message: { subtype: 'success', is_error: false, result: text }, model: 'MiniMax-M3', toolCalls: 1, toolErrors: 0 });

type RecorderOptions = { supervised?: boolean; baseHead?: string | null; commits?: (base: string | null) => number | null; head?: () => string | null };

function makeRecorder(options: RecorderOptions = {}) {
  const { storage, store } = makeStore();
  let stored = 0;
  let clock = 0;
  const asked: Array<{ projectPath: string; base: string | null }> = [];
  const recorder = createForemanEventRecorder({
    store,
    commits: {
      standing: async (projectPath, base) => {
        asked.push({ projectPath, base });
        return { head: options.head ? options.head() : null, commitsSinceBase: options.commits ? options.commits(base) : 0 };
      },
    },
    startOf: () => (options.supervised === false ? null : { baseHead: options.baseHead === undefined ? 'abc123' : options.baseHead, baseSequence: 0 }),
    onStored: () => void (stored += 1),
    now: () => new Date(clock),
  });
  return { recorder, store, storage, asked, stored: () => stored, advance: (ms: number) => void (clock += ms) };
}

test('the recorder stores events in the order they happened and announces each one', async () => {
  const { recorder, store, stored } = makeRecorder();
  recorder.handle({ ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null, allowedTools: [], disallowedTools: [], foremanDispatch: true });
  recorder.handle({ ...base, kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
  recorder.handle(turnEnd());
  recorder.handle({ ...base, kind: 'run_ended', reason: 'aborted' });
  await recorder.whenIdle();
  assert.deepEqual(store.since('sess-1', 0, 10).map((event) => event.kind), ['permission_request', 'turn_end', 'session_end']);
  assert.equal(stored(), 3);
});

test('events of a session Foreman does not supervise are ignored', async () => {
  const { recorder, store } = makeRecorder({ supervised: false });
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  assert.equal(store.last('sess-1'), null);
});

test('a turn reports the commits made since the last report, counted from where supervision began', async () => {
  let total = 2;
  const { recorder, store } = makeRecorder({ commits: () => total });
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  total = 5;
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  total = 5;
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  const counts = store.since('sess-1', 0, 10).map((event) => (event.kind === 'turn_end' ? event.payload.commitCount : -1));
  assert.deepEqual(counts, [2, 3, 0]);
});

test('a turn_end carries the commit the project is at, and git is asked once per turn for that and for the commit count', async () => {
  let head = 'sha-1';
  const { recorder, store, asked } = makeRecorder({ head: () => head, commits: () => 1 });
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  head = 'sha-2';
  recorder.handle(turnEnd());
  recorder.handle({ ...base, kind: 'run_error', message: 'boom' });
  await recorder.whenIdle();
  const heads = store.since('sess-1', 0, 10).map((event) => (event.kind === 'turn_end' ? event.payload.headSha : 'not a turn_end'));
  assert.deepEqual(heads, ['sha-1', 'sha-2', 'not a turn_end']);
  assert.deepEqual(asked, [{ projectPath: '/mnt/dev/repo', base: 'abc123' }, { projectPath: '/mnt/dev/repo', base: 'abc123' }], 'one question per turn, none for an error');
});

test('a session that began with no commit to count from still reports where its project is, and no commits', async () => {
  const { recorder, store, asked } = makeRecorder({ baseHead: null, head: () => 'sha-1', commits: () => null });
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  const event = store.last('sess-1');
  assert.deepEqual(event?.kind === 'turn_end' ? [event.payload.commitCount, event.payload.headSha] : null, [0, 'sha-1']);
  assert.deepEqual(asked.map((question) => question.base), [null]);
});

test('a turn whose project git cannot read has headSha null', async () => {
  const { recorder, store } = makeRecorder({ head: () => null, commits: () => null });
  recorder.handle(turnEnd());
  await recorder.whenIdle();
  const event = store.last('sess-1');
  assert.deepEqual(event?.kind === 'turn_end' ? [event.payload.commitCount, event.payload.headSha] : null, [0, null]);
});

test('a session whose git call is stuck delays only itself, and still gets its own events stored in order', async () => {
  const { store } = makeStore();
  let unstick: () => void = () => undefined;
  const stuck = new Promise<void>((resolve) => { unstick = resolve; });
  const recorder = createForemanEventRecorder({
    store,
    commits: { standing: async (projectPath) => { if (projectPath === '/stuck') await stuck; return { head: null, commitsSinceBase: 0 }; } },
    startOf: () => ({ baseHead: 'abc123', baseSequence: 0 }),
    onStored: () => undefined,
  });
  recorder.handle({ ...turnEnd(), sessionId: 'slow', projectPath: '/stuck' });
  recorder.handle({ sessionId: 'slow', projectPath: '/stuck', kind: 'run_ended', reason: 'aborted' });
  recorder.handle({ ...turnEnd(), sessionId: 'quick', projectPath: '/quick' });
  for (let turns = 0; turns < 50 && !store.last('quick'); turns += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(store.last('quick')?.kind, 'turn_end', 'the other session was not held up');
  assert.equal(store.last('slow'), null, 'nothing of the stuck session got past its first event');
  unstick();
  await recorder.whenIdle();
  assert.deepEqual(store.since('slow', 0, 10).map((event) => event.kind), ['turn_end', 'session_end']);
});

test('a refusal that two signals describe is reported once within the window, and again after it', async () => {
  const { recorder, store, advance } = makeRecorder();
  const stop: ClaudeRuntimeEvent = { ...base, kind: 'assistant_refusal', message: { message: { stop_details: { explanation: 'Declined.' } } } };
  const notice: ClaudeRuntimeEvent = { ...base, kind: 'system_message', message: { subtype: 'model_refusal_no_fallback', explanation: 'Declined.' } };
  recorder.handle(stop);
  recorder.handle(notice);
  await recorder.whenIdle();
  assert.equal(store.since('sess-1', 0, 10).length, 1);
  advance(31_000);
  recorder.handle(notice);
  await recorder.whenIdle();
  assert.equal(store.since('sess-1', 0, 10).length, 2);
});

test('a turn that gave up on a 429 is one quota event: the failure that follows from it is not reported again, and a later failure is', async () => {
  const gaveUp: ClaudeRuntimeEvent = { ...base, kind: 'assistant_error', error: 'rate_limit', text: 'API Error: Request rejected (429)' };
  const failedTurn: ClaudeRuntimeEvent = { ...base, kind: 'turn_result', message: { subtype: 'success', is_error: true, result: 'API Error: Request rejected (429)' }, model: null, toolCalls: 0, toolErrors: 0 };
  const { recorder, store } = makeRecorder();
  recorder.handle(gaveUp);
  recorder.handle(failedTurn);
  recorder.handle({ ...base, kind: 'run_error', message: 'Claude Code process exited with code 1' });
  recorder.handle({ ...base, kind: 'run_ended', reason: 'error' });
  await recorder.whenIdle();
  assert.deepEqual(store.since('sess-1', 0, 10).map((event) => event.kind), ['quota'], 'neither the failed turn, nor the CLI exiting after it, nor the run ending as a crash is a second report');

  // The next run fails for another reason: that is an ordinary error.
  recorder.handle({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null, allowedTools: [], disallowedTools: [], foremanDispatch: true });
  recorder.handle(failedTurn);
  await recorder.whenIdle();
  assert.deepEqual(store.since('sess-1', 1, 10).map((event) => event.kind), ['error']);

  // A held run that is refused again after a turn that got through reports the quota again.
  recorder.handle(turnEnd());
  recorder.handle(gaveUp);
  recorder.handle(failedTurn);
  await recorder.whenIdle();
  assert.deepEqual(store.since('sess-1', 2, 10).map((event) => event.kind), ['turn_end', 'quota']);
});

test('a failure while recording is logged and the next event is still recorded', async () => {
  const { storage, store } = makeStore();
  let attempts = 0;
  const logged: string[] = [];
  const recorder = createForemanEventRecorder({
    store: { append: (sessionId, body) => { attempts += 1; if (attempts === 1) throw new Error('database is locked'); return store.append(sessionId, body); }, reportedCommits: () => 0 },
    commits: { standing: async () => ({ head: null, commitsSinceBase: null }) },
    startOf: () => ({ baseHead: null, baseSequence: 0 }),
    onStored: () => undefined,
    log: (message) => logged.push(message),
  });
  recorder.handle({ ...base, kind: 'run_error', message: 'first' });
  recorder.handle({ ...base, kind: 'run_error', message: 'second' });
  await recorder.whenIdle();
  assert.equal(logged.length, 1);
  assert.equal(storage.rows.length, 1);
});

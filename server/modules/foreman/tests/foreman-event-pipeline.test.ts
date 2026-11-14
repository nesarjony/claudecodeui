import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanEventPusher } from '@/modules/foreman/foreman-event-push.service.js';
import { createForemanEventRecorder } from '@/modules/foreman/foreman-event-recorder.service.js';
import { createForemanEventStore } from '@/modules/foreman/foreman-event-store.service.js';
import type { ClaudeRuntimeEvent } from '@/shared/types.js';

import { createMemoryEventStorage } from './foreman-pipeline-support.js';

const base = { sessionId: 'sess-1', projectPath: '/mnt/dev/repo' };
const turnEnd = (text = 'Row done.'): ClaudeRuntimeEvent => ({ ...base, kind: 'turn_result', message: { subtype: 'success', is_error: false, result: text }, model: 'MiniMax-M3', toolCalls: 1, toolErrors: 0 });

function makeStore() {
  const storage = createMemoryEventStorage();
  return { storage, store: createForemanEventStore({ storage, now: () => new Date('2026-11-14T10:00:00.000Z') }) };
}

test('each session numbers its events from 1 without gaps, and an id is unique across sessions', () => {
  const { store } = makeStore();
  const a1 = store.append('a', { kind: 'refusal', payload: { text: 'no' } });
  const b1 = store.append('b', { kind: 'refusal', payload: { text: 'no' } });
  const a2 = store.append('a', { kind: 'error', payload: { message: 'x' } });
  assert.deepEqual([a1.sequence, a2.sequence, b1.sequence], [1, 2, 1]);
  assert.equal(new Set([a1.id, a2.id, b1.id]).size, 3);
  assert.deepEqual(store.since('a', 1, 10).map((event) => event.sequence), [2]);
  assert.equal(store.last('a')?.id, a2.id);
  assert.equal(store.last('nobody'), null);
});

type RecorderOptions = { supervised?: boolean; commits?: (base: string) => number | null };

function makeRecorder(options: RecorderOptions = {}) {
  const { storage, store } = makeStore();
  let stored = 0;
  let clock = 0;
  const recorder = createForemanEventRecorder({
    store,
    commits: { commitsSince: async (_path, since) => (options.commits ? options.commits(since) : 0) },
    startOf: () => (options.supervised === false ? null : { baseHead: 'abc123', baseSequence: 0 }),
    onStored: () => void (stored += 1),
    now: () => new Date(clock),
  });
  return { recorder, store, storage, stored: () => stored, advance: (ms: number) => void (clock += ms) };
}

test('the recorder stores events in the order they happened and announces each one', async () => {
  const { recorder, store, stored } = makeRecorder();
  recorder.handle({ ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null });
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
  recorder.handle({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null });
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
    commits: { commitsSince: async () => 0 },
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

// ---------------------------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------------------------

type Sent = { url: string; authorization: string | null; body: Record<string, unknown> };

async function withToken(run: (tokenFile: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-push-'));
  const tokenFile = path.join(directory, 'intake-token');
  await writeFile(tokenFile, 'intake-secret\n');
  try {
    await run(tokenFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makePusher(options: { tokenFile: string; answers: Array<number | 'down'>; clock: { now: number }; store?: ReturnType<typeof makeStore>['store'] }) {
  const { store: ownStore } = makeStore();
  const store = options.store ?? ownStore;
  const sent: Sent[] = [];
  const answers = [...options.answers];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, authorization: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const answer = answers.shift() ?? 200;
    if (answer === 'down') throw new Error('connect ECONNREFUSED');
    return new Response(null, { status: answer });
  }) as typeof fetch;
  const pusher = createForemanEventPusher({ store, eventsUrl: 'http://127.0.0.1:4211/intake/events', tokenFile: options.tokenFile, fetchImpl, now: () => options.clock.now });
  return { pusher, store, sent };
}

test('an event is POSTed with the bearer token in the contract shape, and is acknowledged by a 2xx answer', async () => {
  await withToken(async (tokenFile) => {
    const { pusher, store, sent } = makePusher({ tokenFile, answers: [200], clock: { now: 0 } });
    const payload = { text: 'done', commitCount: 1, claimsDone: true, model: 'MiniMax-M3', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: null, cacheCreationTokens: null } };
    const event = store.append('sess-1', { kind: 'turn_end', payload });
    await pusher.kick();
    assert.deepEqual(sent.map((entry) => entry.authorization), ['Bearer intake-secret']);
    assert.deepEqual(sent[0]?.body, { id: event.id, sessionId: 'sess-1', sequence: 1, kind: 'turn_end', payload });
    assert.deepEqual(store.oldestUnackedPerSession(), []);
  });
});

test('events go out in order, a session at a time, and a stuck session holds back only itself', async () => {
  await withToken(async (tokenFile) => {
    const clock = { now: 0 };
    const { pusher, store, sent } = makePusher({ tokenFile, answers: [503, 200, 200, 200], clock });
    store.append('a', { kind: 'refusal', payload: { text: '1' } });
    store.append('a', { kind: 'refusal', payload: { text: '2' } });
    store.append('b', { kind: 'refusal', payload: { text: '1' } });
    await pusher.kick();
    // a:1 failed, so a:2 was not tried; b:1 went through.
    assert.deepEqual(sent.map((entry) => entry.body.id), ['a:1', 'b:1']);
    assert.deepEqual(store.oldestUnackedPerSession().map((event) => event.id), ['a:1']);
    clock.now = 1000;
    await pusher.kick();
    assert.deepEqual(sent.map((entry) => entry.body.id), ['a:1', 'b:1', 'a:1', 'a:2']);
    assert.deepEqual(store.oldestUnackedPerSession(), []);
  });
});

test('a failing event is retried after a doubling delay up to a minute, however often it fails', async () => {
  await withToken(async (tokenFile) => {
    const clock = { now: 0 };
    const { pusher, store, sent } = makePusher({ tokenFile, answers: Array.from({ length: 20 }, () => 'down' as const), clock });
    store.append('a', { kind: 'refusal', payload: { text: '1' } });
    const attemptsAt: number[] = [];
    for (let step = 0; step < 9; step += 1) {
      const before = sent.length;
      await pusher.kick();
      if (sent.length > before) attemptsAt.push(clock.now);
      clock.now += 1000;
    }
    assert.deepEqual(attemptsAt, [0, 1000, 3000, 7000]);
    for (let round = 0; round < 10; round += 1) {
      clock.now += 70_000;
      await pusher.kick();
    }
    const before = sent.length;
    clock.now += 59_000;
    await pusher.kick();
    assert.equal(sent.length, before, 'the delay has reached its cap of a minute');
    clock.now += 1000;
    await pusher.kick();
    assert.equal(sent.length, before + 1);
  });
});

test('an event stored while a push is running is pushed by it, and an idle push can be started again', async () => {
  await withToken(async (tokenFile) => {
    const { pusher, store, sent } = makePusher({ tokenFile, answers: [], clock: { now: 0 } });
    await pusher.kick();
    assert.equal(sent.length, 0, 'nothing owed: nothing sent, and the push is not left looking busy');
    store.append('a', { kind: 'refusal', payload: { text: '1' } });
    const running = pusher.kick();
    await Promise.resolve();
    store.append('a', { kind: 'refusal', payload: { text: '2' } });
    await Promise.all([running, pusher.kick()]);
    assert.deepEqual(sent.map((entry) => entry.body.id), ['a:1', 'a:2']);
    assert.deepEqual(store.oldestUnackedPerSession(), []);
  });
});

test('after a restart the events nobody acknowledged are pushed again, and Foreman answering a repeat with 200 acknowledges it', async () => {
  await withToken(async (tokenFile) => {
    const { store } = makeStore();
    store.append('a', { kind: 'refusal', payload: { text: '1' } });
    const first = makePusher({ tokenFile, answers: ['down'], clock: { now: 0 }, store });
    await first.pusher.kick();
    assert.equal(store.oldestUnackedPerSession().length, 1);
    const restarted = makePusher({ tokenFile, answers: [200], clock: { now: 0 }, store });
    await restarted.pusher.kick();
    assert.equal(restarted.sent.length, 1);
    assert.deepEqual(store.oldestUnackedPerSession(), []);
  });
});

test('with no intake token file configured the push is off: nothing is sent and the event stays owed', async () => {
  const { store } = makeStore();
  store.append('a', { kind: 'refusal', payload: { text: '1' } });
  const sent: unknown[] = [];
  const fetchImpl = (async () => { sent.push(1); return new Response(null, { status: 200 }); }) as typeof fetch;
  await createForemanEventPusher({ store, eventsUrl: 'http://127.0.0.1:1/x', tokenFile: undefined, fetchImpl }).kick();
  assert.equal(sent.length, 0);
  assert.equal(store.oldestUnackedPerSession().length, 1);
});

test('with no token, or a rejecting Foreman, the event stays owed; with no intake URL nothing is pushed at all', async () => {
  const { store } = makeStore();
  store.append('a', { kind: 'refusal', payload: { text: '1' } });
  const sent: unknown[] = [];
  const fetchImpl = (async () => { sent.push(1); return new Response(null, { status: 401 }); }) as typeof fetch;
  const noToken = createForemanEventPusher({ store, eventsUrl: 'http://127.0.0.1:1/x', tokenFile: '/nonexistent/token', fetchImpl });
  await noToken.kick();
  assert.equal(sent.length, 0);
  await withToken(async (tokenFile) => {
    await createForemanEventPusher({ store, eventsUrl: 'http://127.0.0.1:1/x', tokenFile, fetchImpl }).kick();
    assert.equal(sent.length, 1);
    await createForemanEventPusher({ store, eventsUrl: undefined, tokenFile, fetchImpl }).kick();
    assert.equal(sent.length, 1);
  });
  assert.equal(store.oldestUnackedPerSession().length, 1);
});

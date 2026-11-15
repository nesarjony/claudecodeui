import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createForemanEventPusher } from '@/modules/foreman/foreman-event-push.service.js';

import { makeStore } from './foreman-pipeline-support.js';

test('a turn_end stored before it carried headSha reads with headSha null, and one stored with it is returned as it is', () => {
  const { storage, store } = makeStore();
  const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  storage.append('old', 'turn_end', JSON.stringify({ text: 'x', commitCount: 0, claimsDone: false, model: null, usage }), 'then');
  store.append('new', { kind: 'turn_end', payload: { text: 'x', commitCount: 1, headSha: 'abc123', claimsDone: false, model: null, usage } });
  const headOf = (sessionId: string) => {
    const event = store.last(sessionId);
    return event?.kind === 'turn_end' ? event.payload.headSha : 'not a turn_end';
  };
  assert.deepEqual([headOf('old'), headOf('new')], [null, 'abc123']);
});

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
    const payload = { text: 'done', commitCount: 1, headSha: 'abc123', claimsDone: true, model: 'MiniMax-M3', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: null, cacheCreationTokens: null } };
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

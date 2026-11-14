import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createBridgeAuthMiddleware } from '@/modules/foreman/foreman-auth.service.js';
import { createForemanIdempotency } from '@/modules/foreman/foreman-idempotency.service.js';
import {
  createForemanSuggestionsClient,
  createSuggestionBroadcaster,
  parseForemanSuggestion,
  type ForemanSuggestion,
} from '@/modules/foreman/foreman-suggestions.service.js';
import { createForemanUiRouter } from '@/modules/foreman/foreman-ui.routes.js';
import { createForemanRouter } from '@/modules/foreman/foreman.routes.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

import { createMemoryIdempotencyStorage, createWorld } from './foreman-routes-support.js';

const TOKEN = 'suggestion-test-token';
const OPEN = 1;

const suggestion = (over: Record<string, unknown> = {}): ForemanSuggestion => ({
  id: 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11',
  sessionId: 'session-1',
  status: 'pending',
  turnKey: '2026-11-13T09:00:00.000Z|turn_end',
  traceId: 'trace-1',
  decision: {
    decision: { reason: 'verification passed', action: 'run_judge', confidence: 0.9, risk: 'low' },
    model: 'api-haiku',
    escalated: false,
  },
  createdAt: '2026-11-13T09:00:01.000Z',
  ...over,
} as ForemanSuggestion);

class FakeSocket implements RealtimeClientConnection {
  sent: string[] = [];
  constructor(public readyState = OPEN, private readonly failing = false) {}
  send(data: string): void {
    if (this.failing) {
      throw new Error('socket is closing');
    }
    this.sent.push(data);
  }
}

// ---------------------------------------------------------------------------------------------
// Shape check and WebSocket broadcast
// ---------------------------------------------------------------------------------------------

test('parseForemanSuggestion accepts Foreman\'s shape and passes extra fields through untouched', () => {
  const parsed = parseForemanSuggestion(suggestion());
  assert.equal(parsed.id, 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11');
  assert.equal(parsed.traceId, 'trace-1');
  assert.equal(parsed.decision.model, 'api-haiku');
});

test('parseForemanSuggestion rejects a malformed push with a 400', () => {
  const bad: unknown[] = [
    null,
    'x',
    [],
    {},
    suggestion({ id: 'has spaces' }),
    suggestion({ sessionId: '../etc' }),
    suggestion({ status: 'done' }),
    suggestion({ decision: {} }),
    suggestion({ decision: { decision: { action: 'continue' } } }),
    suggestion({ decision: { decision: { reason: 'r' } } }),
  ];
  for (const value of bad) {
    assert.throws(() => parseForemanSuggestion(value), (error: Error & { statusCode?: number }) => error.statusCode === 400, JSON.stringify(value));
  }
});

test('the broadcaster sends one foreman_suggestion frame to every open socket and counts them', () => {
  const a = new FakeSocket();
  const b = new FakeSocket();
  const closed = new FakeSocket(3);
  const broken = new FakeSocket(OPEN, true);
  const broadcaster = createSuggestionBroadcaster({
    clients: () => new Set([a, closed, broken, b]),
    openState: OPEN,
    now: () => new Date('2026-11-13T09:00:02.000Z'),
  });

  assert.equal(broadcaster.broadcast(suggestion()), 2);
  assert.equal(closed.sent.length, 0);
  assert.equal(a.sent.length, 1);
  const frame = JSON.parse(a.sent[0]!);
  assert.equal(frame.kind, 'foreman_suggestion');
  assert.equal(frame.sessionId, 'session-1');
  assert.equal(frame.suggestion.id, 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11');
  assert.equal(frame.suggestion.status, 'pending');
  assert.equal(frame.timestamp, '2026-11-13T09:00:02.000Z');
  assert.equal(b.sent[0], a.sent[0]);
});

test('with nobody connected the broadcast is simply zero', () => {
  assert.equal(createSuggestionBroadcaster({ clients: () => [], openState: OPEN }).broadcast(suggestion()), 0);
});

// ---------------------------------------------------------------------------------------------
// POST /api/foreman/suggestions (bridge token)
// ---------------------------------------------------------------------------------------------

async function withBridgeRouter(
  suggestions: Parameters<typeof createForemanRouter>[0]['suggestions'],
  run: (call: (body?: unknown, token?: string | null) => Promise<{ status: number; body: any }>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-suggestions-'));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/foreman', createForemanRouter({
    authMiddleware: createBridgeAuthMiddleware({ tokenFile }),
    // The suggestion route needs none of the session services.
    sessions: {} as Parameters<typeof createForemanRouter>[0]['sessions'],
    reads: {} as Parameters<typeof createForemanRouter>[0]['reads'],
    handover: {} as Parameters<typeof createForemanRouter>[0]['handover'],
    idempotency: createForemanIdempotency({ storage: createMemoryIdempotencyStorage() }),
    suggestions,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${baseUrl}/api/foreman/suggestions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('POST /api/foreman/suggestions needs the bridge token', async () => {
  const socket = new FakeSocket();
  await withBridgeRouter(createSuggestionBroadcaster({ clients: () => [socket], openState: OPEN }), async (call) => {
    const missing = await call({ suggestion: suggestion() }, null);
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'FOREMAN_BRIDGE_UNAUTHORIZED');
    assert.equal((await call({ suggestion: suggestion() }, 'wrong')).status, 401);
    assert.equal(socket.sent.length, 0, 'nothing is broadcast without the token');
  });
});

test('POST /api/foreman/suggestions validates, broadcasts over the WebSocket and reports how many clients got it', async () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  await withBridgeRouter(createSuggestionBroadcaster({ clients: () => sockets, openState: OPEN }), async (call) => {
    const ok = await call({ suggestion: suggestion() });
    assert.equal(ok.status, 202);
    assert.deepEqual(ok.body, { success: true, data: { delivered: 2 } });
    for (const socket of sockets) {
      const frame = JSON.parse(socket.sent[0]!);
      assert.equal(frame.kind, 'foreman_suggestion');
      assert.equal(frame.suggestion.decision.decision.action, 'run_judge');
    }

    const update = await call({ suggestion: suggestion({ status: 'superseded' }) });
    assert.equal(update.status, 202);
    assert.equal(JSON.parse(sockets[0]!.sent[1]!).suggestion.status, 'superseded');

    const missing = await call({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'INVALID_REQUEST');
    assert.equal((await call({ suggestion: suggestion({ status: 'nope' }) })).status, 400);
    assert.equal(sockets[0]!.sent.length, 2, 'rejected pushes are not broadcast');
  });
});

test('POST /api/foreman/suggestions is 503 when no broadcaster is wired', async () => {
  await withBridgeRouter(undefined, async (call) => {
    const result = await call({ suggestion: suggestion() });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'SUGGESTIONS_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------------------------
// The user-facing routes: proxy to Foreman with the bridge token, server-side
// ---------------------------------------------------------------------------------------------

type ForemanCall = { method: string; url: string; authorization: string | undefined; body: unknown };

async function withUiRouter(
  respond: (call: ForemanCall) => { status: number; json: unknown } | 'down',
  run: (ctx: { call: (method: string, pathname: string, body?: unknown) => Promise<{ status: number; body: any }>; foremanCalls: ForemanCall[]; tokenFile: string }) => Promise<void>,
  options: { state?: Parameters<typeof createForemanUiRouter>[0]['state'] } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-ui-'));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const foremanCalls: ForemanCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry: ForemanCall = {
      method: String(init?.method),
      url: String(url),
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    foremanCalls.push(entry);
    const result = respond(entry);
    if (result === 'down') {
      throw new Error('connect ECONNREFUSED');
    }
    return new Response(JSON.stringify(result.json), { status: result.status });
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use('/api/foreman-suggestions', createForemanUiRouter({
    client: createForemanSuggestionsClient({ tokenFile, baseUrl: 'http://foreman.test:4111', fetchImpl }),
    state: options.state ?? { listSupervised: () => [] },
    // The hand-over grants have their own tests (foreman-routes-handover-grant.test.ts); these never reach them.
    handover: { grant: () => assert.fail('no grant here'), revoke: () => assert.fail('no grant here') },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api/foreman-suggestions${pathname}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ call, foremanCalls, tokenFile });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('GET /pending asks Foreman for the session\'s pending suggestion with the bridge token, server-side', async () => {
  await withUiRouter(() => ({ status: 200, json: { suggestion: suggestion() } }), async ({ call, foremanCalls }) => {
    const result = await call('GET', '/pending?sessionId=session-1');
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.suggestion.id, 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11');
    assert.equal(foremanCalls[0]!.url, 'http://foreman.test:4111/foreman/suggestions?sessionId=session-1');
    assert.equal(foremanCalls[0]!.method, 'GET');
    assert.equal(foremanCalls[0]!.authorization, `Bearer ${TOKEN}`);
    assert.ok(!JSON.stringify(result.body).includes(TOKEN), 'the bridge token never reaches the browser');
  });
});

test('GET /pending answers { suggestion: null } when Foreman has none, and rejects a missing or bad session id', async () => {
  await withUiRouter(() => ({ status: 200, json: { suggestion: null } }), async ({ call, foremanCalls }) => {
    assert.deepEqual((await call('GET', '/pending?sessionId=session-1')).body, { success: true, data: { suggestion: null } });
    assert.equal((await call('GET', '/pending')).status, 400);
    const traversal = await call('GET', '/pending?sessionId=..%2Fadmin');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.error.code, 'INVALID_SESSION_ID');
    assert.equal(foremanCalls.length, 1, 'bad ids never reach Foreman');
  });
});

test('GET /pending is a 502 when Foreman is down (the card just does not show)', async () => {
  await withUiRouter(() => 'down', async ({ call }) => {
    const result = await call('GET', '/pending?sessionId=session-1');
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'FOREMAN_UNAVAILABLE');
  });
});

test('POST /:id/feedback forwards the action and the edited text to Foreman', async () => {
  await withUiRouter(
    () => ({ status: 200, json: { suggestion: suggestion({ status: 'edited' }), feedback: { value: 0.5, traceId: 'trace-1', recorded: true, dataset: true } } }),
    async ({ call, foremanCalls }) => {
      const id = 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11';
      const result = await call('POST', `/${id}/feedback`, { action: 'edited', finalText: 'my wording' });
      assert.equal(result.status, 200);
      assert.equal(result.body.data.feedback.value, 0.5);
      assert.equal(foremanCalls[0]!.url, `http://foreman.test:4111/foreman/suggestions/${id}/feedback`);
      assert.equal(foremanCalls[0]!.method, 'POST');
      assert.deepEqual(foremanCalls[0]!.body, { action: 'edited', finalText: 'my wording' });
      assert.equal(foremanCalls[0]!.authorization, `Bearer ${TOKEN}`);

      const sent = await call('POST', `/${id}/feedback`, { action: 'sent' });
      assert.equal(sent.status, 200);
      assert.deepEqual(foremanCalls[1]!.body, { action: 'sent' });
    },
  );
});

test('POST /:id/feedback validates its input before calling Foreman', async () => {
  await withUiRouter(() => ({ status: 200, json: {} }), async ({ call, foremanCalls }) => {
    const id = 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11';
    assert.equal((await call('POST', `/${id}/feedback`, {})).status, 400);
    assert.equal((await call('POST', `/${id}/feedback`, { action: 'approved' })).status, 400);
    assert.equal((await call('POST', `/${id}/feedback`, { action: 'edited', finalText: 7 })).status, 400);
    assert.equal((await call('POST', '/bad%20id/feedback', { action: 'sent' })).status, 400);
    assert.equal(foremanCalls.length, 0);
  });
});

test('POST /:id/feedback maps Foreman\'s 404 and 409 onto cloudcli errors', async () => {
  const id = 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11';
  await withUiRouter(() => ({ status: 404, json: { error: 'suggestion not found' } }), async ({ call }) => {
    const result = await call('POST', `/${id}/feedback`, { action: 'sent' });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'SUGGESTION_NOT_FOUND');
  });
  await withUiRouter(() => ({ status: 409, json: { error: 'already sent', suggestion: suggestion({ status: 'sent' }) } }), async ({ call }) => {
    const result = await call('POST', `/${id}/feedback`, { action: 'dismissed' });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'SUGGESTION_NOT_PENDING');
    assert.equal(result.body.error.details.suggestion.status, 'sent');
  });
});

test('with no bridge token file the user routes answer 503 instead of calling Foreman', async () => {
  await withUiRouter(() => ({ status: 200, json: {} }), async ({ call, tokenFile, foremanCalls }) => {
    await rm(tokenFile);
    const result = await call('GET', '/pending?sessionId=session-1');
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'FOREMAN_BRIDGE_DISABLED');
    assert.equal(foremanCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Milestone 4: execute (write_notes, handoff) and the notes view
// ---------------------------------------------------------------------------------------------

const SUGGESTION_ID = 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11';

test('POST /:id/execute has Foreman carry out the action, with the bridge token and without a body, and passes its result back', async () => {
  const result = { ok: true, action: 'handoff', result: { newSessionId: 'new-1', notesVersion: 3, handoffId: 'ho_1' }, feedback: { suggestion: { status: 'sent' } } };
  await withUiRouter(() => ({ status: 200, json: result }), async ({ call, foremanCalls }) => {
    const out = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(out.status, 200);
    assert.equal(out.body.data.result.newSessionId, 'new-1');
    assert.equal(foremanCalls[0]!.url, `http://foreman.test:4111/foreman/suggestions/${SUGGESTION_ID}/execute`);
    assert.equal(foremanCalls[0]!.method, 'POST');
    assert.equal(foremanCalls[0]!.authorization, `Bearer ${TOKEN}`);
    assert.ok(!JSON.stringify(out.body).includes(TOKEN));
  });
});

test('POST /:id/execute maps Foreman\'s 404, 409, 422 and failures onto cloudcli errors, and refuses a bad id before calling Foreman', async () => {
  const answers = new Map<string, { status: number; json: unknown }>([
    ['missing', { status: 404, json: { error: 'suggestion not found' } }],
    ['answered', { status: 409, json: { error: 'suggestion is not pending' } }],
    ['unsupported', { status: 422, json: { error: 'Foreman cannot execute "steer" itself; it goes through Send' } }],
    ['failed', { status: 502, json: { error: 'UNKNOWN_PROJECT: projectPath is not a known cloudcli project.' } }],
  ]);
  let current = 'missing';
  await withUiRouter(() => answers.get(current)!, async ({ call, foremanCalls }) => {
    current = 'missing';
    const notFound = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, 'SUGGESTION_NOT_FOUND');
    current = 'answered';
    const answered = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(answered.status, 409);
    assert.equal(answered.body.error.code, 'SUGGESTION_NOT_PENDING');
    current = 'unsupported';
    const unsupported = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error.code, 'CANNOT_EXECUTE');
    assert.match(unsupported.body.error.message, /goes through Send/);
    current = 'failed';
    const failed = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'FOREMAN_EXECUTE_FAILED');
    assert.match(failed.body.error.message, /UNKNOWN_PROJECT/);
    const before = foremanCalls.length;
    assert.equal((await call('POST', '/..%2Fx/execute', {})).status, 400);
    assert.equal(foremanCalls.length, before, 'a bad id never reaches Foreman');
  });
});

test('POST /:id/execute is a 502 when Foreman is down', async () => {
  await withUiRouter(() => 'down', async ({ call }) => {
    const out = await call('POST', `/${SUGGESTION_ID}/execute`, {});
    assert.equal(out.status, 502);
    assert.equal(out.body.error.code, 'FOREMAN_UNAVAILABLE');
  });
});

test('GET /notes proxies the latest notes for the session (login-protected route, bridge token kept server-side)', async () => {
  const notes = { version: 4, turn: 7, createdAt: '2026-11-13T10:00:00.000Z', content: '# Task notes\n\n## Goal & Definition of Done\nShip it.\n', key: 'session-s1', model: 'api-haiku' };
  await withUiRouter(() => ({ status: 200, json: { notes } }), async ({ call, foremanCalls }) => {
    const out = await call('GET', '/notes?sessionId=session-1');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.notes, { content: notes.content, version: 4, turn: 7, createdAt: notes.createdAt });
    assert.equal(foremanCalls[0]!.url, 'http://foreman.test:4111/foreman/notes?sessionId=session-1');
    assert.equal(foremanCalls[0]!.authorization, `Bearer ${TOKEN}`);
    assert.ok(!JSON.stringify(out.body).includes(TOKEN));
  });
});

test('GET /notes answers null when there are none, and validates the session id', async () => {
  await withUiRouter(() => ({ status: 200, json: { notes: null } }), async ({ call, foremanCalls }) => {
    assert.deepEqual((await call('GET', '/notes?sessionId=session-1')).body, { success: true, data: { notes: null } });
    assert.equal((await call('GET', '/notes')).status, 400);
    const traversal = await call('GET', '/notes?sessionId=..%2Fadmin');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.error.code, 'INVALID_SESSION_ID');
    assert.equal(foremanCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /supervised: which sessions Foreman supervises, for the sidebar
// ---------------------------------------------------------------------------------------------

test('GET /supervised lists the sessions Foreman started or was handed, and leaves out released ones and the owner\'s own', async () => {
  // The real state service over an in-memory store, as the module wires it over the database.
  const { world } = createWorld();
  world.state.track('worker', { supervision: 'started', taskId: 'task-1' });
  world.state.track('handed-over', { supervision: 'adopted', taskId: null });
  world.state.track('given-back', { supervision: 'adopted' });
  world.state.track('given-back', { supervision: 'released' });
  world.addOwnerSession('owner');

  await withUiRouter(() => ({ status: 200, json: {} }), async ({ call, foremanCalls }) => {
    const response = await call('GET', '/supervised');
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    const sessions = (response.body.data.sessions as Array<{ sessionId: string }>).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.deepEqual(sessions, [
      { sessionId: 'handed-over', supervision: 'adopted', taskId: null },
      { sessionId: 'worker', supervision: 'started', taskId: 'task-1' },
    ]);
    assert.equal(foremanCalls.length, 0, 'it is answered from cloudcli\'s own state, Foreman is not asked');

    // A session leaves the list the moment it is released, and joins it again when handed over again.
    world.state.track('handed-over', { supervision: 'released' });
    assert.deepEqual((await call('GET', '/supervised')).body.data.sessions.map((entry: { sessionId: string }) => entry.sessionId), ['worker']);
    world.state.track('given-back', { supervision: 'adopted' });
    assert.deepEqual(
      (await call('GET', '/supervised')).body.data.sessions.map((entry: { sessionId: string }) => entry.sessionId).sort(),
      ['given-back', 'worker'],
    );
  }, { state: world.state });
});

test('GET /supervised is an empty list when Foreman supervises nothing', async () => {
  await withUiRouter(() => ({ status: 200, json: {} }), async ({ call }) => {
    assert.deepEqual((await call('GET', '/supervised')).body, { success: true, data: { sessions: [] } });
  }, { state: createWorld().world.state });
});

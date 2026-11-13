import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyModelBilling,
  createForemanEventPusher,
  createRuntimeOutcomeTracker,
  createTurnCostTracker,
  declaredModelBilling,
  splitModelBilling,
  toForemanEvent,
  type ForemanEventSessionContext,
} from '@/modules/foreman/foreman-events.service.js';
import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';
import type { ClaudeRuntimeEvent, ForemanBilling, ForemanEvent } from '@/shared/types.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const SESSION: ForemanEventSessionContext = { billing: 'api-key', title: 'Fix the handler', taskId: 'task-42' };

type TurnResultEvent = Extract<ClaudeRuntimeEvent, { kind: 'turn_result' }>;

const base = { sessionId: 'sess-1', projectPath: '/mnt/dev/repo' };

function turnResult(overrides: Partial<TurnResultEvent> & { message?: Record<string, unknown> } = {}): TurnResultEvent {
  return {
    ...base,
    kind: 'turn_result',
    model: 'claude-sonnet-5-5',
    toolCalls: 7,
    toolErrors: 2,
    ...overrides,
    message: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      result: 'All done',
      duration_ms: 12_345,
      num_turns: 4,
      total_cost_usd: 0.5,
      usage: { input_tokens: 11, output_tokens: 222, cache_read_input_tokens: 3333, cache_creation_input_tokens: 44 },
      modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.5 } },
      ...overrides.message,
    },
  };
}

const translate = (event: ClaudeRuntimeEvent, turnCostUsd: number | null = null, session = SESSION) =>
  toForemanEvent(event, { now: NOW, session, turnCostUsd });

// ---------------------------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------------------------

const COMMON = { billing: 'api-key', title: 'Fix the handler', taskId: 'task-42' };

test('the envelope is exactly type, session, project and timestamp; every data carries billing, title and taskId', () => {
  const event = translate({ ...base, kind: 'run_ended', reason: 'completed' });
  assert.deepEqual(event, {
    type: 'session_ended',
    sessionId: 'sess-1',
    projectPath: '/mnt/dev/repo',
    ts: '2026-11-13T10:00:00.000Z',
    data: { ...COMMON, reason: 'completed' },
  });
});

test('every event type carries billing and title in its data', () => {
  const events: ClaudeRuntimeEvent[] = [
    { ...base, kind: 'run_started', resumed: false, model: 'sonnet', permissionMode: null },
    { ...base, kind: 'run_ended', reason: 'completed' },
    { ...base, kind: 'run_error', message: 'x' },
    turnResult(),
    { ...base, kind: 'permission_request', requestId: 'r', toolName: 'Bash', input: {} },
    { ...base, kind: 'assistant_refusal', message: { message: {} } },
    { ...base, kind: 'system_message', message: { subtype: 'compact_boundary' } },
    { ...base, kind: 'system_message', message: { subtype: 'model_refusal_no_fallback' } },
  ];
  const seen = new Set<string>();
  for (const event of events) {
    const translated = translate(event);
    assert.ok(translated, event.kind);
    assert.equal(translated.data.billing, 'api-key', event.kind);
    assert.equal(translated.data.title, 'Fix the handler', event.kind);
    assert.equal(translated.data.taskId, 'task-42', event.kind);
    assert.deepEqual(Object.keys(translated).sort(), ['data', 'projectPath', 'sessionId', 'ts', 'type'], event.kind);
    seen.add(translated.type);
  }
  assert.equal(seen.size, 7, 'all seven event types were produced');
});

test('taskId is omitted when the session was not started with one', () => {
  const event = translate({ ...base, kind: 'run_ended', reason: 'aborted' }, null, { billing: 'subscription', title: null });
  assert.equal('taskId' in (event as ForemanEvent).data, false);
  assert.equal(event?.data.billing, 'subscription');
  assert.equal(event?.data.title, null);
});

test('an event with no known project reports an empty project path rather than null', () => {
  const event = translate({ sessionId: 'sess-1', projectPath: null, kind: 'run_ended', reason: 'completed' });
  assert.equal(event?.projectPath, '');
});

test('turn_end carries the worker usage for the turn', () => {
  const event = translate(turnResult(), 0.125);
  assert.equal(event?.type, 'turn_end');
  const data = event?.data ?? {};
  // The contract keys, exactly as the supervisor reads them.
  assert.deepEqual(
    {
      model: data.model,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
      cacheCreationTokens: data.cacheCreationTokens,
      costUsd: data.costUsd,
      durationMs: data.durationMs,
      numTurns: data.numTurns,
      toolCalls: data.toolCalls,
      toolErrors: data.toolErrors,
      stopReason: data.stopReason,
      isError: data.isError,
    },
    {
      model: 'claude-sonnet-5-5',
      inputTokens: 11,
      outputTokens: 222,
      cacheReadTokens: 3333,
      cacheCreationTokens: 44,
      costUsd: 0.125,
      durationMs: 12_345,
      numTurns: 4,
      toolCalls: 7,
      toolErrors: 2,
      stopReason: 'end_turn',
      isError: false,
    },
  );
  // Additive context: the cumulative total is reported separately from the per-turn cost.
  assert.equal(data.totalCostUsd, 0.5);
  assert.equal(data.subtype, 'success');
});

test('turn_end uses null for anything the result did not report', () => {
  const event = translate(turnResult({
    model: null,
    message: {
      usage: undefined,
      modelUsage: undefined,
      duration_ms: undefined,
      num_turns: undefined,
      stop_reason: undefined,
      total_cost_usd: undefined,
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['boom'],
    },
  }));
  const data = event?.data ?? {};
  for (const key of ['model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'durationMs', 'numTurns', 'stopReason', 'totalCostUsd']) {
    assert.equal(data[key], null, key);
  }
  assert.equal(data.isError, true);
  assert.deepEqual(data.errors, ['boom']);
});

test('the turn model falls back to the only model the result billed', () => {
  const event = translate(turnResult({ model: null }));
  assert.equal(event?.data.model, 'claude-sonnet-5-5');
  const ambiguous = translate(turnResult({ model: null, message: { modelUsage: { a: {}, b: {} } } }));
  assert.equal(ambiguous?.data.model, null);
});

test('session_started reports resume, model, billing and permission mode', () => {
  const event = translate({ ...base, kind: 'run_started', resumed: false, model: 'claude-opus-5-5[1m]@api', permissionMode: 'acceptEdits' });
  assert.equal(event?.type, 'session_started');
  assert.deepEqual(event?.data, { ...COMMON, resumed: false, model: 'claude-opus-5-5[1m]', permissionMode: 'acceptEdits' });
});

test('a session with no row yet reports the billing its own run declared', () => {
  const event = translate(
    { ...base, kind: 'run_started', resumed: false, model: 'sonnet@api', permissionMode: null },
    null,
    { billing: null, title: null },
  );
  assert.equal(event?.data.billing, 'api-key');
});

test('error carries the message', () => {
  const event = translate({ ...base, kind: 'run_error', message: 'spawn ENOENT' });
  assert.equal(event?.type, 'error');
  assert.deepEqual(event?.data, { ...COMMON, source: 'run', message: 'spawn ENOENT' });
  const long = translate({ ...base, kind: 'run_error', message: 'x'.repeat(5000) });
  assert.ok(String(long?.data.message).length <= 500);
});

test('permission_request carries the tool name, the request id and a short input', () => {
  const event = translate({
    ...base,
    kind: 'permission_request',
    requestId: 'req-9',
    toolName: 'Bash',
    input: { command: `rm -rf build && ${'echo hi '.repeat(100)}`, description: 'clean' },
  });
  assert.equal(event?.type, 'permission_request');
  assert.equal(event?.data.requestId, 'req-9');
  assert.equal(event?.data.toolName, 'Bash');
  const input = String(event?.data.input);
  assert.ok(input.startsWith('rm -rf build && echo hi'));
  assert.ok(input.length <= 200);
  assert.ok(!input.includes('\n'));
});

test('a guarded permission_request adds its category and the guarded flag, and carries a longer input', () => {
  const command = `git push origin main && ${'echo hi '.repeat(100)}`;
  const event = translate({
    ...base,
    kind: 'permission_request',
    requestId: 'req-10',
    toolName: 'Bash',
    input: { command },
    guarded: true,
    category: 'command',
  });
  assert.equal(event?.type, 'permission_request');
  assert.deepEqual(
    { requestId: event?.data.requestId, toolName: event?.data.toolName, category: event?.data.category, guarded: event?.data.guarded },
    { requestId: 'req-10', toolName: 'Bash', category: 'command', guarded: true },
  );
  const input = String(event?.data.input);
  assert.ok(input.startsWith('git push origin main && echo hi'));
  assert.ok(input.length > 200 && input.length <= 1000, `guarded input is ${input.length} characters`);
});

test('a guarded permission_request from a guard with an allowlist says so; one without does not', () => {
  const held = { ...base, kind: 'permission_request' as const, requestId: 'r', toolName: 'Write', input: { file_path: '/tmp/x.md' }, guarded: true, category: 'outside_repo' };
  assert.equal(translate({ ...held, allowlist: true })?.data.allowlist, true);
  assert.equal('allowlist' in (translate(held)?.data ?? {}), false);
});

test('an unguarded permission_request has neither category nor guarded', () => {
  const event = translate({ ...base, kind: 'permission_request', requestId: 'r', toolName: 'Bash', input: { command: 'ls' } });
  assert.ok(event);
  assert.equal('category' in (event?.data ?? {}), false);
  assert.equal('guarded' in (event?.data ?? {}), false);
});

test('a guarded request whose category is unknown reports null', () => {
  const event = translate({ ...base, kind: 'permission_request', requestId: 'r', toolName: 'Bash', input: {}, guarded: true });
  assert.equal(event?.data.category, null);
  assert.equal(event?.data.guarded, true);
});

test('a permission prompt ending is internal: Foreman gets no event for it', () => {
  assert.equal(translate({ ...base, kind: 'permission_resolved', requestId: 'req-10' }), null);
});

test('refusal from a stop reason carries the category and request id', () => {
  const event = translate({
    ...base,
    kind: 'assistant_refusal',
    message: {
      request_id: 'req_abc',
      message: { id: 'msg_1', model: 'claude-sonnet-5-5', stop_details: { category: 'cyber', explanation: 'Blocked.' } },
    },
  });
  assert.equal(event?.type, 'refusal');
  assert.deepEqual(event?.data, {
    ...COMMON,
    source: 'stop_reason',
    model: 'claude-sonnet-5-5',
    requestId: 'req_abc',
    messageId: 'msg_1',
    category: 'cyber',
    explanation: 'Blocked.',
  });
});

test('refusal from the structured notices carries category, request id and models', () => {
  const noFallback = translate({
    ...base,
    kind: 'system_message',
    message: {
      subtype: 'model_refusal_no_fallback',
      original_model: 'claude-sonnet-5-5[1m]',
      request_id: 'req_1',
      api_refusal_category: 'reasoning_extraction',
      api_refusal_explanation: 'Blocked as it violates the terms.',
    },
  });
  assert.equal(noFallback?.type, 'refusal');
  assert.equal(noFallback?.data.fallback, false);
  assert.equal(noFallback?.data.category, 'reasoning_extraction');
  assert.equal(noFallback?.data.requestId, 'req_1');
  assert.equal(noFallback?.data.originalModel, 'claude-sonnet-5-5[1m]');

  const fallback = translate({
    ...base,
    kind: 'system_message',
    message: { subtype: 'model_refusal_fallback', original_model: 'a', fallback_model: 'b', scope: 'session' },
  });
  assert.equal(fallback?.data.fallback, true);
  assert.equal(fallback?.data.fallbackModel, 'b');
  assert.equal(fallback?.data.category, null);

  // The whole payload of a fallback notice, as the real CLI shapes it.
  const full = translate({
    ...base,
    kind: 'system_message',
    message: {
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      scope: 'session',
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-sonnet-5-5',
      request_id: 'req_9',
      api_refusal_category: 'reasoning_extraction',
      api_refusal_explanation: 'Blocked.',
    },
  });
  assert.equal(full?.type, 'refusal');
  assert.deepEqual(full?.data, {
    ...COMMON,
    source: 'model_refusal_fallback',
    fallback: true,
    originalModel: 'claude-opus-5-5',
    fallbackModel: 'claude-sonnet-5-5',
    scope: 'session',
    requestId: 'req_9',
    category: 'reasoning_extraction',
    explanation: 'Blocked.',
  });
});

test('compact_boundary carries the trigger and the sizes before and after', () => {
  const event = translate({
    ...base,
    kind: 'system_message',
    message: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 480_000, post_tokens: 16_000, duration_ms: 90_000 } },
  });
  assert.equal(event?.type, 'compact_boundary');
  assert.deepEqual(event?.data, { ...COMMON, trigger: 'manual', preTokens: 480_000, postTokens: 16_000, durationMs: 90_000 });
});

test('system messages that are not observed, and events without a session, map to nothing', () => {
  assert.equal(translate({ ...base, kind: 'system_message', message: { subtype: 'task_progress' } }), null);
  assert.equal(translate({ sessionId: '', projectPath: null, kind: 'run_ended', reason: 'completed' }), null);
});

test('billing helpers read and apply the @api marker', () => {
  assert.deepEqual(splitModelBilling('sonnet@api'), { model: 'sonnet', billing: 'api-key' });
  assert.deepEqual(splitModelBilling('claude-opus-5-5[1m]'), { model: 'claude-opus-5-5[1m]', billing: 'subscription' });
  assert.deepEqual(splitModelBilling(null), { model: null, billing: 'subscription' });
  assert.equal(applyModelBilling('sonnet', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@api', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@api', 'subscription'), 'sonnet');
});

test('billing helpers read and apply the @cap marker, and a model never carries two markers', () => {
  assert.deepEqual(splitModelBilling('claude-sonnet-5-5@cap'), { model: 'claude-sonnet-5-5', billing: 'cap' });
  assert.deepEqual(splitModelBilling('claude-opus-5-5[1m]@cap'), { model: 'claude-opus-5-5[1m]', billing: 'cap' });
  assert.deepEqual(splitModelBilling('  sonnet@cap  '), { model: 'sonnet', billing: 'cap' });
  assert.equal(applyModelBilling('sonnet', 'cap'), 'sonnet@cap');
  assert.equal(applyModelBilling('sonnet@cap', 'cap'), 'sonnet@cap');
  // Switching the billing replaces the marker instead of stacking a second one.
  assert.equal(applyModelBilling('sonnet@api', 'cap'), 'sonnet@cap');
  assert.equal(applyModelBilling('sonnet@cap', 'api-key'), 'sonnet@api');
  assert.equal(applyModelBilling('sonnet@cap', 'subscription'), 'sonnet');
  // A value that somehow carries both: the outermost marker decides, every marker is removed.
  assert.deepEqual(splitModelBilling('sonnet@api@cap'), { model: 'sonnet', billing: 'cap' });
  assert.deepEqual(splitModelBilling('sonnet@cap@api'), { model: 'sonnet', billing: 'api-key' });
  // A marker alone is no model.
  assert.deepEqual(splitModelBilling('@cap'), { model: null, billing: 'cap' });
});

test('every billing survives marker and split round trips (plain model, [1m] form, repeated application, model switch)', () => {
  const billings: ForemanBilling[] = ['api-key', 'subscription', 'cap'];
  for (const model of ['default', 'sonnet', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'haiku']) {
    for (const billing of billings) {
      const marked = applyModelBilling(model, billing);
      assert.deepEqual(splitModelBilling(marked), { model, billing }, `${model} ${billing}`);
      assert.equal(applyModelBilling(marked, billing), marked, `${model} ${billing} idempotent`);
      // A model switch (what POST /model stores): the new plain model gets the session's billing back.
      const switched = applyModelBilling('claude-opus-5-5', splitModelBilling(marked).billing);
      assert.deepEqual(splitModelBilling(switched), { model: 'claude-opus-5-5', billing }, `${model} ${billing} switch`);
    }
  }
});

test('declaredModelBilling reads the marker only: a plain model declares nothing', () => {
  assert.equal(declaredModelBilling('sonnet@cap'), 'cap');
  assert.equal(declaredModelBilling('sonnet@api'), 'api-key');
  assert.equal(declaredModelBilling('sonnet'), null);
  assert.equal(declaredModelBilling(''), null);
  assert.equal(declaredModelBilling(null), null);
});

// The runtime strips the same literals (claude-runtime-events.test.ts drives `@api` and `@cap` runs through the real runtime).
test('the markers the bridge writes are @api for api-key and @cap for cap', () => {
  assert.equal(applyModelBilling('x', 'api-key'), 'x@api');
  assert.equal(applyModelBilling('x', 'cap'), 'x@cap');
  assert.equal(applyModelBilling('x', 'subscription'), 'x');
});

test('a cap session reports billing cap on its events and the plain model on session_started', () => {
  const event = toForemanEvent(
    { ...base, kind: 'run_started', resumed: false, model: 'claude-sonnet-5-5@cap', permissionMode: 'acceptEdits' },
    { now: NOW, session: { billing: null, title: null }, turnCostUsd: null },
  );
  assert.equal(event?.data.billing, 'cap');
  assert.equal(event?.data.model, 'claude-sonnet-5-5');
  // Once the row exists its billing is what every later event carries.
  const turn = toForemanEvent(
    turnResult(),
    { now: NOW, session: { billing: 'cap', title: 'Worker', taskId: 'task-1' }, turnCostUsd: 0 },
  );
  assert.equal(turn?.data.billing, 'cap');
});

// ---------------------------------------------------------------------------------------------
// Per-turn cost
// ---------------------------------------------------------------------------------------------

test('a turn costs the change in the CLI running total', () => {
  const costs = createTurnCostTracker();
  const total = (usd: number) => turnResult({ message: { total_cost_usd: usd } });

  assert.equal(costs.observe({ ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null }), null);
  assert.equal(costs.observe(total(0.3)), 0.3);
  assert.equal(costs.observe(total(0.75)), 0.45);
});

test('the first result of a resumed run has no known baseline, later ones do', () => {
  const costs = createTurnCostTracker();
  const total = (usd: number) => turnResult({ message: { total_cost_usd: usd } });

  costs.observe({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null });
  assert.equal(costs.observe(total(8.2)), null);
  assert.equal(costs.observe(total(8.5)), 0.3);
});

test('a resumed run continues from the previous run of the same session', () => {
  const costs = createTurnCostTracker();
  const total = (usd: number) => turnResult({ message: { total_cost_usd: usd } });

  costs.observe({ ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null });
  costs.observe(total(1));
  costs.observe({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null });
  assert.equal(costs.observe(total(1.4)), 0.4);
});

test('a total that goes down (a cleared session) or is missing gives no cost', () => {
  const costs = createTurnCostTracker();
  costs.observe({ ...base, kind: 'run_started', resumed: false, model: null, permissionMode: null });
  costs.observe(turnResult({ message: { total_cost_usd: 5 } }));
  assert.equal(costs.observe(turnResult({ message: { total_cost_usd: 0.2 } })), null);
  assert.equal(costs.observe(turnResult({ message: { total_cost_usd: undefined } })), null);
});

test('the outcome tracker marks a failed session until it runs again', () => {
  const outcomes = createRuntimeOutcomeTracker();
  assert.equal(outcomes.hasFailed('sess-1'), false);
  outcomes.observe({ ...base, kind: 'run_error', message: 'boom' });
  assert.equal(outcomes.hasFailed('sess-1'), true);
  outcomes.observe({ ...base, kind: 'run_started', resumed: true, model: null, permissionMode: null });
  assert.equal(outcomes.hasFailed('sess-1'), false);
  outcomes.observe(turnResult({ message: { is_error: true, subtype: 'error_max_turns' } }));
  assert.equal(outcomes.hasFailed('sess-1'), true);
  outcomes.observe(turnResult());
  assert.equal(outcomes.hasFailed('sess-1'), false);
});

// ---------------------------------------------------------------------------------------------
// Task links
// ---------------------------------------------------------------------------------------------

test('the task link is kept in memory and persisted so it survives a restart', () => {
  const persisted = new Map<string, string>();
  const backing = { get: (key: string) => persisted.get(key) ?? null, set: (key: string, value: string) => void persisted.set(key, value) };

  const first = createTaskIdStore(backing);
  assert.equal(first.get('sess-1'), null);
  first.set('sess-1', 'task-7');
  assert.equal(first.get('sess-1'), 'task-7');
  assert.equal(persisted.size, 1);

  // A fresh store (a restarted process) reads it back from the backing store.
  assert.equal(createTaskIdStore(backing).get('sess-1'), 'task-7');
});

test('a failing backing store never breaks the task link', () => {
  const store = createTaskIdStore({
    get: () => { throw new Error('db closed'); },
    set: () => { throw new Error('db closed'); },
  });
  store.set('sess-1', 'task-7');
  assert.equal(store.get('sess-1'), 'task-7');
  assert.equal(store.get('other'), null);
});

// ---------------------------------------------------------------------------------------------
// The pusher
// ---------------------------------------------------------------------------------------------

type Received = { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: ForemanEvent };

async function withForeman(
  respond: (request: http.IncomingMessage, response: http.ServerResponse, received: Received[]) => void,
  run: (url: string, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as ForemanEvent,
      });
      respond(request, response, received);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/foreman/events`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withToken(token: string | null, run: (tokenFile: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-events-'));
  const tokenFile = path.join(directory, 'bridge-token');
  try {
    if (token !== null) {
      await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    }
    await run(tokenFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ok = (_request: http.IncomingMessage, response: http.ServerResponse) => {
  response.statusCode = 204;
  response.end();
};

const describeSession = () => SESSION;

test('an event is POSTed with the bearer token and the contract body', async () => {
  await withToken('push-token', async (tokenFile) => {
    await withForeman(ok, async (eventsUrl, received) => {
      const debug: string[] = [];
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, describeSession, now: () => NOW, debug: (m) => debug.push(m) });

      pusher.handle(turnResult());
      await pusher.whenIdle();

      assert.equal(received.length, 1);
      assert.equal(received[0].method, 'POST');
      assert.equal(received[0].url, '/foreman/events');
      assert.equal(received[0].headers.authorization, 'Bearer push-token');
      assert.equal(received[0].headers['content-type'], 'application/json');
      const body = received[0].body;
      assert.deepEqual(Object.keys(body).sort(), ['data', 'projectPath', 'sessionId', 'ts', 'type']);
      assert.equal(body.type, 'turn_end');
      assert.equal(body.sessionId, 'sess-1');
      assert.equal(body.projectPath, '/mnt/dev/repo');
      assert.equal(body.ts, '2026-11-13T10:00:00.000Z');
      assert.equal(body.data.billing, 'api-key');
      assert.equal(body.data.title, 'Fix the handler');
      assert.equal(body.data.taskId, 'task-42');
      assert.equal(body.data.outputTokens, 222);
      assert.deepEqual(debug, []);
    });
  });
});

test('events are delivered in order, one at a time', async () => {
  await withToken('t', async (tokenFile) => {
    let concurrent = 0;
    let maxConcurrent = 0;
    await withForeman((_request, response) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => {
        concurrent -= 1;
        response.statusCode = 204;
        response.end();
      }, 15);
    }, async (eventsUrl, received) => {
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, describeSession, now: () => NOW });
      pusher.handle({ ...base, kind: 'run_started', resumed: false, model: 'sonnet', permissionMode: 'default' });
      pusher.handle(turnResult());
      pusher.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      await pusher.whenIdle();

      assert.deepEqual(received.map((entry) => entry.body.type), ['session_started', 'turn_end', 'session_ended']);
      assert.equal(maxConcurrent, 1);
    });
  });
});

test('the default target is the local Foreman endpoint, and FOREMAN_EVENTS_URL overrides it', async () => {
  await withToken('t', async (tokenFile) => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const saved = process.env.FOREMAN_EVENTS_URL;
    try {
      delete process.env.FOREMAN_EVENTS_URL;
      const standard = createForemanEventPusher({ tokenFile, fetchImpl, describeSession });
      standard.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      await standard.whenIdle();

      process.env.FOREMAN_EVENTS_URL = 'http://127.0.0.1:9999/custom';
      const overridden = createForemanEventPusher({ tokenFile, fetchImpl, describeSession });
      overridden.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      await overridden.whenIdle();
    } finally {
      if (saved === undefined) {
        delete process.env.FOREMAN_EVENTS_URL;
      } else {
        process.env.FOREMAN_EVENTS_URL = saved;
      }
    }
    assert.deepEqual(urls, ['http://127.0.0.1:4111/foreman/events', 'http://127.0.0.1:9999/custom']);
  });
});

test('with no token file nothing is sent and the runtime is not disturbed', async () => {
  await withToken(null, async (tokenFile) => {
    await withForeman(ok, async (eventsUrl, received) => {
      const debug: string[] = [];
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, describeSession, debug: (m) => debug.push(m) });

      pusher.handle(turnResult());
      await pusher.whenIdle();

      assert.equal(received.length, 0);
      assert.equal(debug.length, 1);
      assert.match(debug[0], /bridge disabled/);
    });
  });
});

test('a Foreman that is down is swallowed with a debug line only', async () => {
  await withToken('t', async (tokenFile) => {
    // Claim a port, then release it so nothing listens there.
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const debug: string[] = [];
    const pusher = createForemanEventPusher({
      tokenFile,
      eventsUrl: `http://127.0.0.1:${port}/foreman/events`,
      describeSession,
      debug: (m) => debug.push(m),
    });

    assert.doesNotThrow(() => pusher.handle(turnResult()));
    await pusher.whenIdle();
    assert.equal(debug.length, 1);
    assert.match(debug[0], /not delivered/);
  });
});

test('a Foreman error status is logged at debug level and does not stop later events', async () => {
  await withToken('t', async (tokenFile) => {
    let calls = 0;
    await withForeman((_request, response) => {
      calls += 1;
      response.statusCode = calls === 1 ? 500 : 204;
      response.end();
    }, async (eventsUrl, received) => {
      const debug: string[] = [];
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, describeSession, debug: (m) => debug.push(m) });
      pusher.handle(turnResult());
      pusher.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      await pusher.whenIdle();

      assert.equal(received.length, 2);
      assert.equal(debug.length, 1);
      assert.match(debug[0], /HTTP 500/);
    });
  });
});

test('a Foreman that never answers is cut off by the timeout and the next event still goes out', async () => {
  await withToken('t', async (tokenFile) => {
    let calls = 0;
    await withForeman((_request, response) => {
      calls += 1;
      if (calls > 1) {
        response.statusCode = 204;
        response.end();
      }
      // The first request is left hanging.
    }, async (eventsUrl, received) => {
      const debug: string[] = [];
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, timeoutMs: 150, describeSession, debug: (m) => debug.push(m) });
      const started = Date.now();
      pusher.handle(turnResult());
      pusher.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      await pusher.whenIdle();

      assert.ok(Date.now() - started < 2000, 'the hung request must not block the queue for long');
      assert.equal(received.length, 2);
      assert.equal(debug.length, 1);
      assert.match(debug[0], /not delivered/);
    });
  });
});

test('the default timeout is two seconds', async () => {
  await withToken('t', async (tokenFile) => {
    await withForeman(() => { /* never answers */ }, async (eventsUrl) => {
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, describeSession });
      const started = Date.now();
      pusher.handle(turnResult());
      await pusher.whenIdle();
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1800 && elapsed < 3500, `expected about 2000ms, took ${elapsed}ms`);
    });
  });
});

test('handle returns at once: it never waits for Foreman', async () => {
  await withToken('t', async (tokenFile) => {
    await withForeman(() => { /* never answers */ }, async (eventsUrl) => {
      const pusher = createForemanEventPusher({ tokenFile, eventsUrl, timeoutMs: 300, describeSession });
      const started = process.hrtime.bigint();
      pusher.handle(turnResult());
      pusher.handle(turnResult());
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(elapsedMs < 50, `handle took ${elapsedMs}ms`);
      await pusher.whenIdle();
    });
  });
});

test('a failing session lookup or a malformed event never throws into the runtime', async () => {
  await withToken('t', async (tokenFile) => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const debug: string[] = [];
    const pusher = createForemanEventPusher({
      tokenFile,
      fetchImpl,
      describeSession: () => { throw new Error('db locked'); },
      debug: (m) => debug.push(m),
    });

    assert.doesNotThrow(() => pusher.handle(turnResult()));
    assert.doesNotThrow(() => pusher.handle({} as unknown as ClaudeRuntimeEvent));
    assert.doesNotThrow(() => pusher.handle({ ...base, kind: 'turn_result', message: null } as unknown as ClaudeRuntimeEvent));
    await pusher.whenIdle();

    // The lookup failure degrades the envelope (billing unknown) but the event still goes out.
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as ForemanEvent).data.billing, null);
    assert.ok(debug.some((message) => /session lookup failed/.test(message)));
  });
});

test('one refusal is reported once even when two signals describe it', async () => {
  await withToken('t', async (tokenFile) => {
    const sent: ForemanEvent[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as ForemanEvent);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    let clock = NOW.getTime();
    const pusher = createForemanEventPusher({ tokenFile, fetchImpl, describeSession, now: () => new Date(clock) });

    pusher.handle({ ...base, kind: 'assistant_refusal', message: { message: { model: 'm', stop_details: { category: 'cyber' } } } });
    clock += 2000;
    pusher.handle({ ...base, kind: 'system_message', message: { subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' } });
    // A different session is not suppressed.
    pusher.handle({ sessionId: 'sess-2', projectPath: null, kind: 'assistant_refusal', message: { message: {} } });
    // Long after, the same session may refuse again.
    clock += 60_000;
    pusher.handle({ ...base, kind: 'assistant_refusal', message: { message: {} } });
    await pusher.whenIdle();

    assert.deepEqual(sent.map((event) => [event.type, event.sessionId]), [
      ['refusal', 'sess-1'],
      ['refusal', 'sess-2'],
      ['refusal', 'sess-1'],
    ]);
  });
});

test('a fallback notice is reported even when the refused message was reported just before it, and then folds later signals in', async () => {
  await withToken('t', async (tokenFile) => {
    const sent: ForemanEvent[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as ForemanEvent);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    let clock = NOW.getTime();
    const pusher = createForemanEventPusher({ tokenFile, fetchImpl, describeSession, now: () => new Date(clock) });

    pusher.handle({ ...base, kind: 'assistant_refusal', message: { message: { model: 'claude-opus-5-5', stop_details: { category: 'reasoning_extraction' } } } });
    clock += 1000;
    pusher.handle({
      ...base,
      kind: 'system_message',
      message: { subtype: 'model_refusal_fallback', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5', scope: 'session', api_refusal_category: 'reasoning_extraction' },
    });
    // Anything else about the same refusal after the notice is folded into it, as before.
    clock += 1000;
    pusher.handle({ ...base, kind: 'system_message', message: { subtype: 'model_refusal_no_fallback', api_refusal_category: 'reasoning_extraction' } });
    await pusher.whenIdle();

    assert.deepEqual(sent.map((event) => [event.type, event.data.source, event.data.fallback]), [
      ['refusal', 'stop_reason', undefined],
      ['refusal', 'model_refusal_fallback', true],
    ]);
    assert.equal(sent[1]!.data.originalModel, 'claude-opus-5-5');
    assert.equal(sent[1]!.data.fallbackModel, 'claude-sonnet-5-5');
  });
});

test('when Foreman cannot keep up the oldest queued events are dropped', async () => {
  await withToken('t', async (tokenFile) => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String((JSON.parse(String(init?.body)) as ForemanEvent).data.title ?? ''));
      await gate;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const debug: string[] = [];
    let n = 0;
    const pusher = createForemanEventPusher({
      tokenFile,
      fetchImpl,
      maxQueuedEvents: 3,
      describeSession: () => ({ billing: 'api-key', title: `event-${n++}` }),
      debug: (m) => debug.push(m),
    });

    // The first is taken by the in-flight request; the next five contend for three queue slots.
    for (let i = 0; i < 6; i += 1) {
      pusher.handle({ ...base, kind: 'run_ended', reason: 'completed' });
      if (i === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    release();
    await pusher.whenIdle();

    assert.deepEqual(sent, ['event-0', 'event-3', 'event-4', 'event-5']);
    assert.equal(debug.filter((message) => /queue full/.test(message)).length, 2);
  });
});

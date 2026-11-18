import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { format } from 'node:util';

import express from 'express';

import { assertLoopback, createForemanNextClient } from '@/modules/foreman-next/foreman-next.client.js';
import { createForemanNextRouter } from '@/modules/foreman-next/foreman-next.module.js';
import { FOREMAN_NEXT_ROUTES } from '@/modules/foreman-next/foreman-next.routes.js';
import { createServiceLog } from '@/modules/foreman-next/foreman-next.service-log.js';
import { readTokenFile } from '@/modules/foreman-next/foreman-next.token.js';

const TOKEN = 'proxy-token-0123456789';

type Seen = { method: string; url: string; authorization: string | undefined; body: string };

/** A stand-in for Foreman: it notes what reached it and answers as a test says. */
async function fakeForeman(answer: (request: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() };
      seen.push(entry);
      const { status, body } = answer(entry);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The proxy over a fake Foreman; `received` holds each URL exactly as Express was given it. The token is a value, or a function that reads it. */
async function proxyOver(foremanUrl: string, token: string | undefined | (() => Promise<string | null>), serviceLogFile?: string, fetchFn?: typeof fetch) {
  const app = express();
  const received: string[] = [];
  app.use((incoming, _response, next) => {
    received.push(incoming.originalUrl);
    next();
  });
  app.use(express.json());
  const tokenSource = typeof token === 'function' ? token : async () => token ?? null;
  app.use('/api/foreman-next', createForemanNextRouter({ client: createForemanNextClient({ baseUrl: foremanUrl, token: tokenSource }, fetchFn), serviceLog: createServiceLog({ file: serviceLogFile, journalCommand: 'journalctl', unit: 'foreman-next', secrets: async () => [] }) }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman-next`;
  return { base, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * One request with the path exactly as written, and its status. `fetch` normalises `/status/..` away before it is sent, so a probe of a path trick
 * over `fetch` never reaches Express as the trick; `node:http` sends what it is given.
 */
function rawStatus(base: string, probe: string, method = 'GET'): Promise<number> {
  const { hostname, port, pathname } = new URL(base);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: hostname, port, method, path: `${pathname}${probe}` }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Runs `body` with `console.error` recorded (and silent), and returns what it logged, one string per call. */
async function withErrorLog<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const spy = mock.method(console, 'error', () => undefined);
  try {
    const result = await body();
    return { result, lines: spy.mock.calls.map((call) => format(...call.arguments)) };
  } finally {
    spy.mock.restore();
  }
}

test('forwards a read with the API token and wraps Foreman\'s answer in the envelope', async () => {
  const foreman = await fakeForeman(() => ({ status: 200, body: { state: 'running' } }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  const response = await fetch(`${proxy.base}/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { state: 'running' } });
  assert.deepEqual(foreman.seen.map((entry) => [entry.method, entry.url, entry.authorization]), [['GET', '/foreman/status', `Bearer ${TOKEN}`]]);
  await proxy.close();
  await foreman.close();
});

test('forwards a body and an id with colons, and only the query the route names', async () => {
  const foreman = await fakeForeman(() => ({ status: 200, body: null }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  const id = 'owner:decide:run-1:event:2';
  const answered = await fetch(`${proxy.base}/decide/questions/${encodeURIComponent(id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ optionId: 'A', reply: null, remember: null, delegate: false }) });
  assert.equal(answered.status, 200);
  await fetch(`${proxy.base}/chat/thread?kind=goal&id=g1&other=x`);
  assert.equal(foreman.seen[0]?.url, `/foreman/decide/questions/${encodeURIComponent(id)}/answer`);
  assert.deepEqual(JSON.parse(foreman.seen[0]?.body ?? ''), { optionId: 'A', reply: null, remember: null, delegate: false });
  assert.equal(foreman.seen[1]?.url, '/foreman/chat/thread?kind=goal&id=g1');
  await proxy.close();
  await foreman.close();
});

test('forwards a change of a goal\'s limits with its body, relays Foreman\'s refusal, and gives that path no other method', async () => {
  const foreman = await fakeForeman((request) => (request.body.includes('2020') ? { status: 400, body: { error: { code: 'invalid', message: 'the deadline has already passed' } } } : { status: 200, body: { id: 'goal:1', budget: { limitUsd: 60, deadline: null } } }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  try {
    const headers = { 'content-type': 'application/json' };
    const changed = await fetch(`${proxy.base}/work/goals/${encodeURIComponent('goal:1')}/limits`, { method: 'POST', headers, body: JSON.stringify({ budgetUsd: 60, deadline: null }) });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { success: true, data: { id: 'goal:1', budget: { limitUsd: 60, deadline: null } } });
    const refused = await fetch(`${proxy.base}/work/goals/g1/limits`, { method: 'POST', headers, body: JSON.stringify({ deadline: '2020-01-01T00:00:00.000Z' }) });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { success: false, error: { code: 'invalid', message: 'the deadline has already passed' } });
    assert.deepEqual(
      foreman.seen.map((entry) => [entry.method, entry.url, entry.authorization]),
      [['POST', `/foreman/work/goals/${encodeURIComponent('goal:1')}/limits`, `Bearer ${TOKEN}`], ['POST', '/foreman/work/goals/g1/limits', `Bearer ${TOKEN}`]],
    );
    assert.deepEqual(JSON.parse(foreman.seen[0]?.body ?? ''), { budgetUsd: 60, deadline: null });
    assert.deepEqual(JSON.parse(foreman.seen[1]?.body ?? ''), { deadline: '2020-01-01T00:00:00.000Z' });
    // Only the POST is the contract's: a read, a replace, a delete and a path below it reach nothing, and an id that is not one is refused.
    for (const [method, probe, status] of [['GET', '/work/goals/g1/limits', 404], ['PUT', '/work/goals/g1/limits', 404], ['DELETE', '/work/goals/g1/limits', 404], ['POST', '/work/goals/g1/limits/extra', 404], ['POST', '/work/goals/a%20b/limits', 400], ['POST', '/work/goals/%2e%2e/limits', 400]] as const) {
      assert.equal(await rawStatus(proxy.base, probe, method), status, `${method} ${probe}`);
    }
    assert.equal(foreman.seen.length, 2);
  } finally {
    await proxy.close();
    await foreman.close();
  }
});

test('keeps Foreman\'s refusal code and message, and says so when Foreman does not answer or has no token', async () => {
  const foreman = await fakeForeman(() => ({ status: 409, body: { error: { code: 'conflict', message: 'the question was already answered' } } }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  const refused = await fetch(`${proxy.base}/decide/questions/q1/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { success: false, error: { code: 'conflict', message: 'the question was already answered' } });
  await foreman.close();

  const down = await fetch(`${proxy.base}/status`);
  assert.equal(down.status, 502);
  assert.equal(((await down.json()) as { error: { code: string } }).error.code, 'FOREMAN_UNREACHABLE');
  await proxy.close();

  const unconfigured = await proxyOver('http://127.0.0.1:9', undefined);
  const missing = await fetch(`${unconfigured.base}/status`);
  assert.equal(missing.status, 503);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'FOREMAN_NOT_CONFIGURED');
  await unconfigured.close();
});

test('reaches nothing of Foreman\'s outside the contract: no other path, no path tricks, no other method', async () => {
  const foreman = await fakeForeman(() => ({ status: 200, body: {} }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  try {
    // Raw HTTP, so each literal path reaches Express: a path that matches no route is a 404, and an id route with an id that is not one is a 400.
    const probes: Array<[probe: string, status: number]> = [
      ['/api/workflows', 404],
      ['/knowledge', 404],
      ['/status/../../api/workflows', 404],
      ['/decisions/..%2F..%2Fapi', 400],
      ['/decisions/a%20b', 400],
    ];
    for (const [probe, status] of probes) assert.equal(await rawStatus(proxy.base, probe), status, probe);
    const wrongMethods: Array<[method: string, probe: string]> = [['DELETE', '/status'], ['POST', '/status'], ['GET', '/status/pause'], ['PUT', '/decisions/d1']];
    for (const [method, probe] of wrongMethods) assert.equal(await rawStatus(proxy.base, probe, method), 404, `${method} ${probe}`);
    const prefix = new URL(proxy.base).pathname;
    assert.deepEqual(proxy.received.slice(0, probes.length), probes.map(([probe]) => `${prefix}${probe}`), 'the paths reached Express as they were written');
    assert.deepEqual(foreman.seen, []);
  } finally {
    await proxy.close();
    await foreman.close();
  }
});

test('allows exactly the endpoints the UI contract declares, so the allowlist and the contract cannot drift apart', async () => {
  const declared = (await readFile(path.join(process.cwd(), 'src/modules/foreman-next/api/contract/endpoints.ts'), 'utf8')).matchAll(/method: '(GET|POST|PUT)', path: '([^']+)'/g);
  // The service log is cloudcli\'s own, read from a file here, and not an endpoint of Foreman\'s.
  const contract = [...declared].map((match) => `${match[1]} ${match[2]}`).filter((endpoint) => endpoint !== 'GET /service-log').sort();
  const allowed = FOREMAN_NEXT_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
  assert.ok(contract.length > 40);
  assert.deepEqual(allowed, contract);
  assert.equal(new Set(allowed).size, allowed.length);
});

test('refuses an id of dots, and a target that is not this machine, since the token goes there', async () => {
  const foreman = await fakeForeman(() => ({ status: 200, body: {} }));
  const proxy = await proxyOver(foreman.url, TOKEN);
  try {
    const probes = ['/decisions/.', '/decisions/..', '/decisions/%2e', '/decisions/%2e%2e'];
    for (const probe of probes) assert.equal(await rawStatus(proxy.base, probe), 400, probe);
    const prefix = new URL(proxy.base).pathname;
    assert.deepEqual(proxy.received, probes.map((probe) => `${prefix}${probe}`), 'the paths reached Express as they were written');
    assert.deepEqual(foreman.seen, []);
  } finally {
    await proxy.close();
    await foreman.close();
  }
  assert.throws(() => assertLoopback('http://foreman.example.com:4211'), /loopback/);
  assert.throws(() => assertLoopback('http://192.168.1.5:4211'), /loopback/);
  for (const ok of ['http://127.0.0.1:4211', 'http://localhost:4211', 'http://[::1]:4211']) assert.doesNotThrow(() => assertLoopback(ok));
});

test('serves the tail of Foreman\'s service log itself, and an empty one when there is no file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-next-log-'));
  const file = path.join(directory, 'server.log');
  await writeFile(file, ['one', 'two', 'three'].join('\n'));
  const foreman = await fakeForeman(() => ({ status: 200, body: {} }));
  const withLog = await proxyOver(foreman.url, TOKEN, file);
  assert.deepEqual(await (await fetch(`${withLog.base}/service-log`)).json(), { success: true, data: ['one', 'two', 'three'] });
  const without = await proxyOver(foreman.url, TOKEN, path.join(directory, 'none.log'));
  assert.deepEqual(await (await fetch(`${without.base}/service-log`)).json(), { success: true, data: [] });
  assert.deepEqual(foreman.seen, []);
  await withLog.close();
  await without.close();
  await foreman.close();
});

test('answers a fixed 502 when the request to Foreman throws, and neither the answer nor the log holds the token', async () => {
  const header = `Bearer ${TOKEN}`;
  const failures: Array<[logged: string, failure: Error]> = [
    ['TypeError', new TypeError(`Headers.append: "${header}" is an invalid header value.`)],
    ['TypeError (ECONNREFUSED)', Object.assign(new TypeError(`fetch failed ${header}`), { cause: Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:4211 ${header}`), { code: 'ECONNREFUSED' }) })],
    ['TimeoutError', new DOMException(`The operation timed out. ${header}`, 'TimeoutError')],
  ];
  for (const [logged, failure] of failures) {
    const proxy = await proxyOver('http://127.0.0.1:9', TOKEN, undefined, async () => {
      throw failure;
    });
    try {
      const { result, lines } = await withErrorLog(async () => {
        const response = await fetch(`${proxy.base}/status`);
        return { status: response.status, text: await response.text() };
      });
      assert.equal(result.status, 502);
      assert.equal(result.text, JSON.stringify({ success: false, error: { code: 'FOREMAN_UNREACHABLE', message: 'Foreman did not answer.' } }));
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.ok(lines[0]?.startsWith('[Foreman next]'), lines[0]);
      assert.ok(lines[0]?.endsWith(`: ${logged}`), `${lines[0]} should end with ${logged}`);
      for (const text of [result.text, ...lines]) assert.ok(!text.includes(TOKEN) && !text.includes('Bearer'), 'the token must not be in the answer or the log');
    } finally {
      await proxy.close();
    }
  }
});

test('a token with a line break inside it never reaches Foreman: the file is refused as malformed, and a header that fetch itself refuses is a fixed 502', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-next-token-'));
  const file = path.join(directory, 'next-api-token');
  const lines = ['api-token-0123456789abc', 'second-line-0123456789'];
  await writeFile(file, `${lines.join('\n')}\n`);
  await chmod(file, 0o600);
  const foreman = await fakeForeman(() => ({ status: 200, body: {} }));
  const refusedFile = await proxyOver(foreman.url, () => readTokenFile(file));
  // The same token handed to the client directly, as if the format check were not there: real `fetch` throws on the header and the answer stays fixed.
  const refusedHeader = await proxyOver(foreman.url, async () => lines.join('\n'));
  try {
    const { result, lines: logged } = await withErrorLog(async () => {
      const fromFile = await fetch(`${refusedFile.base}/status`);
      const fromHeader = await fetch(`${refusedHeader.base}/status`);
      return { fromFile: [fromFile.status, await fromFile.text()] as const, fromHeader: [fromHeader.status, await fromHeader.text()] as const };
    });
    assert.equal(result.fromFile[0], 503);
    assert.equal((JSON.parse(result.fromFile[1]) as { error: { code: string } }).error.code, 'FOREMAN_NOT_CONFIGURED');
    assert.equal(result.fromHeader[0], 502);
    assert.equal(result.fromHeader[1], JSON.stringify({ success: false, error: { code: 'FOREMAN_UNREACHABLE', message: 'Foreman did not answer.' } }));
    assert.deepEqual(foreman.seen, []);
    assert.ok(logged.some((line) => line.includes(file)), 'the refusal names the file');
    for (const text of [result.fromFile[1], result.fromHeader[1], ...logged]) for (const line of lines) assert.ok(!text.includes(line), 'no line of the token file may be in an answer or the log');
  } finally {
    await refusedFile.close();
    await refusedHeader.close();
    await foreman.close();
    await rm(directory, { recursive: true, force: true });
  }
});

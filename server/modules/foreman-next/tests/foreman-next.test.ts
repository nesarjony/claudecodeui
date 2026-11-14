import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createForemanNextClient } from '@/modules/foreman-next/foreman-next.client.js';
import { createForemanNextRouter } from '@/modules/foreman-next/foreman-next.module.js';
import { FOREMAN_NEXT_ROUTES } from '@/modules/foreman-next/foreman-next.routes.js';

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

async function proxyOver(foremanUrl: string, token: string | undefined, serviceLogFile?: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/foreman-next', createForemanNextRouter({ client: createForemanNextClient({ baseUrl: foremanUrl, token }), serviceLogFile }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman-next`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
    for (const probe of ['/api/workflows', '/knowledge', '/status/../../api/workflows', '/decisions/..%2F..%2Fapi', '/decisions/a%20b']) {
      const response = await fetch(`${proxy.base}${probe}`);
      assert.ok([400, 404].includes(response.status), `${probe} answered ${response.status}`);
    }
    assert.equal((await fetch(`${proxy.base}/status`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(foreman.seen, []);
  } finally {
    await proxy.close();
    await foreman.close();
  }
});

test('lists exactly the contract\'s forty-two endpoints', () => {
  assert.equal(FOREMAN_NEXT_ROUTES.length, 42);
  assert.equal(new Set(FOREMAN_NEXT_ROUTES.map((route) => `${route.method} ${route.path}`)).size, 42);
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

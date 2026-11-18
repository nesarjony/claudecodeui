import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import type { ForemanHandoverService } from '@/modules/foreman/foreman-handover.service.js';
import type { ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import { createForemanSuggestionsClient } from '@/modules/foreman/foreman-suggestions.service.js';
import { createForemanUiModule } from '@/modules/foreman/foreman.module.js';

/**
 * The suggestion card is the old Foreman's. `FOREMAN_URL` names the rebuilt one (the cutover sets it), which has no suggestions or notes endpoint, so
 * the card asking it with the bridge token only failed (`FOREMAN_ERROR`, 502) on every chat that opened. With it set the card has nobody to ask.
 */

const SUGGESTION_ID = 'sug_0b8f6a52-4a1c-4d2c-8a52-0d1c6a0f3a11';
const NO_TOKEN = '/nonexistent/foreman-suggestions-retired/bridge-token';

const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('a retired suggestions client answers none at once and calls no Foreman, not even to read the token', async () => {
  const calls: string[] = [];
  const client = createForemanSuggestionsClient({
    tokenFile: NO_TOKEN,
    baseUrl: 'http://foreman.test:4211',
    retired: true,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.equal(await client.getPending('session-1'), null);
  assert.equal(await client.getNotes('session-1'), null);
  await assert.rejects(client.execute(SUGGESTION_ID), refused('SUGGESTION_NOT_FOUND'));
  await assert.rejects(client.sendFeedback(SUGGESTION_ID, { action: 'dismissed' }), refused('SUGGESTION_NOT_FOUND'));
  // The ids are still checked first, so a malformed request is still a 400 and not a quiet "none".
  await assert.rejects(client.getPending('not a session id!'), refused('INVALID_SESSION_ID'));
  assert.deepEqual(calls, []);
});

test('a client that is not retired still asks Foreman, which needs its token', async () => {
  const client = createForemanSuggestionsClient({ tokenFile: NO_TOKEN, baseUrl: 'http://foreman.test:4211' });
  await assert.rejects(client.getPending('session-1'), refused('FOREMAN_BRIDGE_DISABLED'));
});

const ENVIRONMENT_KEYS = ['FOREMAN_URL', 'FOREMAN_EVENTS_URL', 'FOREMAN_BRIDGE_TOKEN_FILE'] as const;

/** A Foreman that records what reaches it: the module and the client's base URL are both read from the process environment, so the test sets it there and puts it back. */
async function recorder() {
  const requests: string[] = [];
  const app = express();
  app.use((request, response) => {
    requests.push(`${request.method} ${request.originalUrl}`);
    response.json({ suggestion: null, notes: null });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function withModule(environment: (origin: string, tokenFile: string) => Record<string, string>, run: (ctx: { call: (pathname: string) => Promise<{ status: number; body: any }>; requests: string[] }) => Promise<void>) {
  const foreman = await recorder();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-suggestions-retired-'));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, 'retired-test-token', { mode: 0o600 });
  const saved = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  Object.assign(process.env, environment(foreman.origin, tokenFile));
  const app = express();
  app.use('/api/foreman-suggestions', createForemanUiModule({ state: { listSupervised: () => [] } as unknown as ForemanSessionStateService, handover: {} as unknown as ForemanHandoverService }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (pathname: string) => {
    const response = await fetch(`${baseUrl}/api/foreman-suggestions${pathname}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ call, requests: foreman.requests });
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await foreman.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('with FOREMAN_URL set, opening a chat finds no suggestion and no error, and nothing reaches the rebuilt Foreman', async () => {
  await withModule(
    (origin, tokenFile) => ({ FOREMAN_URL: origin, FOREMAN_BRIDGE_TOKEN_FILE: tokenFile }),
    async ({ call, requests }) => {
      const pending = await call('/pending?sessionId=session-1');
      assert.equal(pending.status, 200);
      assert.equal(pending.body.success, true);
      assert.equal(pending.body.data.suggestion, null);
      const notes = await call('/notes?sessionId=session-1');
      assert.equal(notes.status, 200);
      assert.equal(notes.body.data.notes, null);
      // The supervised list is cloudcli's own and stays.
      assert.deepEqual((await call('/supervised')).body.data.sessions, []);
      assert.deepEqual(requests, []);
    },
  );
});

test('without FOREMAN_URL the suggestion card still asks the old Foreman (here named by its events URL)', async () => {
  await withModule(
    (origin, tokenFile) => ({ FOREMAN_EVENTS_URL: `${origin}/events`, FOREMAN_BRIDGE_TOKEN_FILE: tokenFile }),
    async ({ call, requests }) => {
      assert.equal((await call('/pending?sessionId=session-1')).status, 200);
      assert.deepEqual(requests, ['GET /foreman/suggestions?sessionId=session-1']);
    },
  );
});

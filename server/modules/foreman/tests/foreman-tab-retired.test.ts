import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createForemanTabModule, oldForemanTabEnabled } from '@/modules/foreman/foreman-tab.module.js';

/** No token file: a request that reaches the tab's router is refused for it before anything is sent, so the test calls no Foreman. */
const NO_TOKEN = '/nonexistent/foreman-tab-test/bridge-token';

/** The app mounts the tab the way `server/index.ts` does: only when the module made a router. */
async function appFor(environment: NodeJS.ProcessEnv) {
  const app = express();
  const router = createForemanTabModule(environment);
  if (router) app.use('/api/foreman-tab', router);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the old Foreman tab is on while FOREMAN_URL is unset or blank, and off once it names a Foreman', () => {
  assert.equal(oldForemanTabEnabled({}), true);
  assert.equal(oldForemanTabEnabled({ FOREMAN_URL: '' }), true);
  assert.equal(oldForemanTabEnabled({ FOREMAN_URL: '   ' }), true);
  assert.equal(oldForemanTabEnabled({ FOREMAN_URL: 'http://127.0.0.1:4211' }), false);
});

test('with FOREMAN_URL set the tab has no routes: nothing is mounted, so nothing of the old tab can call the rebuilt Foreman with the bridge token', async () => {
  assert.equal(createForemanTabModule({ FOREMAN_URL: 'http://127.0.0.1:4211' }), null);
  const retired = await appFor({ FOREMAN_URL: 'http://127.0.0.1:4211', FOREMAN_BRIDGE_TOKEN_FILE: NO_TOKEN });
  const live = await appFor({ FOREMAN_BRIDGE_TOKEN_FILE: NO_TOKEN });
  try {
    // `/overview` is the tab's first route: unmounted it is Express's own 404, and mounted it is the tab's router, which answers with its own envelope.
    const gone = await fetch(`${retired.url}/api/foreman-tab/overview`);
    assert.equal(gone.status, 404);
    assert.ok(!(await gone.text()).includes('"success"'), 'no tab router answered');
    const mounted = await fetch(`${live.url}/api/foreman-tab/overview`);
    assert.equal(mounted.status, 503);
    assert.equal(((await mounted.json()) as { error: { code: string } }).error.code, 'FOREMAN_BRIDGE_DISABLED');
  } finally {
    await retired.close();
    await live.close();
  }
});

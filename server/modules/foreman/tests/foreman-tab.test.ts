import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createForemanTabRouter } from '@/modules/foreman/foreman-tab.routes.js';
import { createForemanTabClient, FOREMAN_TAB_ROUTES } from '@/modules/foreman/foreman-tab.service.js';

const TOKEN = 'tab-test-token';
const TRACE = 'a'.repeat(32);
const GOAL = 'goal_0b7c6f1e-4a2d-4f3e-9c8b-1d2e3f4a5b6c';
const NEW_GOAL = {
  title: 'Move checkout to the new tax service',
  description: 'Replace the inline tax maths with calls to the tax service, behind a flag.',
  repos: ['desk', 'web'],
  constraints: 'No schema change.',
  budgetUsd: 5,
  deadline: '2026-12-01T17:00:00.000Z',
  requirePlanApproval: true,
};

type ForemanCall = { method: string; url: string; authorization?: string; body?: unknown };
type Responder = (call: ForemanCall) => { status: number; json: unknown } | 'down';

async function withTabRouter(
  respond: Responder,
  run: (context: {
    call: (method: string, pathname: string, body?: unknown) => Promise<{ status: number; body: any; headers: Headers }>;
    foremanCalls: ForemanCall[];
  }) => Promise<void>,
  options: { token?: string | null } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-tab-'));
  const tokenFile = path.join(directory, 'bridge-token');
  if (options.token !== null) {
    await writeFile(tokenFile, options.token ?? TOKEN, { mode: 0o600 });
  }
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
  app.use('/api/foreman-tab', createForemanTabRouter({
    client: createForemanTabClient({ tokenFile, baseUrl: 'http://foreman.test:4111', fetchImpl }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api/foreman-tab${pathname}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  try {
    await run({ call, foremanCalls });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

const ok = (json: unknown = { fine: true }) => () => ({ status: 200, json });

// Every route the tab uses, with a request that is valid for it and the Foreman call it must become.
const CASES: Array<{ method: string; path: string; body?: unknown; foreman: { method: string; url: string; body?: unknown } }> = [
  { method: 'GET', path: '/overview', foreman: { method: 'GET', url: '/foreman/ui/overview' } },
  { method: 'GET', path: '/decisions?limit=20&sessionId=session-1', foreman: { method: 'GET', url: '/foreman/decisions?limit=20&sessionId=session-1' } },
  { method: 'GET', path: '/spend?range=7d', foreman: { method: 'GET', url: '/foreman/spend?range=7d' } },
  { method: 'GET', path: '/agreement?range=all', foreman: { method: 'GET', url: '/foreman/agreement?range=all' } },
  { method: 'GET', path: '/config', foreman: { method: 'GET', url: '/foreman/config' } },
  { method: 'PUT', path: '/config', body: { budgets: { perDayUsd: 30 } }, foreman: { method: 'PUT', url: '/foreman/config', body: { budgets: { perDayUsd: 30 } } } },
  { method: 'GET', path: `/studio-link?traceId=${TRACE}`, foreman: { method: 'GET', url: `/foreman/ui/studio-link?traceId=${TRACE}` } },
  { method: 'GET', path: '/tasks?status=running', foreman: { method: 'GET', url: '/foreman/tasks?status=running' } },
  { method: 'GET', path: '/tasks/task-1', foreman: { method: 'GET', url: '/foreman/tasks/task-1' } },
  { method: 'POST', path: '/tasks/task-1/takeover', foreman: { method: 'POST', url: '/foreman/tasks/task-1/takeover' } },
  { method: 'POST', path: '/kill', foreman: { method: 'POST', url: '/foreman/kill' } },
  { method: 'POST', path: '/resume', foreman: { method: 'POST', url: '/foreman/resume' } },
  { method: 'GET', path: '/inbox', foreman: { method: 'GET', url: '/foreman/inbox' } },
  { method: 'POST', path: '/inbox/inb_1/answer', body: { allow: false, reason: 'not now' }, foreman: { method: 'POST', url: '/foreman/inbox/inb_1/answer', body: { allow: false, reason: 'not now' } } },
  { method: 'GET', path: '/lessons?repo=desk', foreman: { method: 'GET', url: '/foreman/lessons?repo=desk' } },
  { method: 'POST', path: '/lessons/les_1/retire', foreman: { method: 'POST', url: '/foreman/lessons/les_1/retire' } },
  { method: 'GET', path: '/goals?status=running,paused', foreman: { method: 'GET', url: '/foreman/goals?status=running%2Cpaused' } },
  { method: 'POST', path: '/goals', body: NEW_GOAL, foreman: { method: 'POST', url: '/foreman/goals', body: NEW_GOAL } },
  { method: 'GET', path: `/goals/${GOAL}`, foreman: { method: 'GET', url: `/foreman/goals/${GOAL}` } },
  { method: 'POST', path: `/goals/${GOAL}/approve-plan`, body: { decision: 'approve', note: 'keep it small' }, foreman: { method: 'POST', url: `/foreman/goals/${GOAL}/approve-plan`, body: { decision: 'approve', note: 'keep it small' } } },
  { method: 'POST', path: `/goals/${GOAL}/pause`, foreman: { method: 'POST', url: `/foreman/goals/${GOAL}/pause` } },
  { method: 'POST', path: `/goals/${GOAL}/resume`, foreman: { method: 'POST', url: `/foreman/goals/${GOAL}/resume` } },
  { method: 'POST', path: `/goals/${GOAL}/cancel`, body: { reason: 'not needed any more' }, foreman: { method: 'POST', url: `/foreman/goals/${GOAL}/cancel`, body: { reason: 'not needed any more' } } },
];

test('the allowlist covers exactly the routes of the Foreman tab contract', () => {
  const declared = FOREMAN_TAB_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
  const expected = CASES.map((entry) => `${entry.method} ${entry.path.split('?')[0]!.replace(/\/(task-1|inb_1|les_1|goal_[0-9a-f-]+)(?=\/|$)/, '/:id')}`).sort();
  assert.deepEqual(declared, expected);
});

for (const entry of CASES) {
  test(`${entry.method} ${entry.path.split('?')[0]} is forwarded to Foreman ${entry.foreman.method} ${entry.foreman.url.split('?')[0]} with the bridge token, server-side`, async () => {
    await withTabRouter(ok({ answer: 42 }), async ({ call, foremanCalls }) => {
      const result = await call(entry.method, entry.path, entry.body);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { success: true, data: { answer: 42 } });
      assert.equal(foremanCalls.length, 1);
      assert.equal(foremanCalls[0]!.method, entry.foreman.method);
      assert.equal(foremanCalls[0]!.url, `http://foreman.test:4111${entry.foreman.url}`);
      assert.equal(foremanCalls[0]!.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(foremanCalls[0]!.body, entry.foreman.body);
      assert.ok(!JSON.stringify(result.body).includes(TOKEN), 'the bridge token never reaches the browser');
    });
  });
}

test('routes Foreman has but the tab must not reach are a 404 and never call Foreman', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    for (const [method, pathname] of [
      ['POST', '/events'],
      ['POST', '/decide'],
      ['POST', '/evals/run'],
      ['GET', '/suggestions?all=1'],
      ['POST', '/suggestions/sug_x/feedback'],
      ['GET', '/foreman/config'],
      ['GET', '/..%2Fapi%2Fagents'],
      ['DELETE', '/config'],
      ['POST', '/overview'],
      ['PUT', '/kill'],
      ['GET', '/tasks/task-1/takeover'],
      ['DELETE', `/goals/${GOAL}`],
      ['PUT', `/goals/${GOAL}`],
      ['GET', `/goals/${GOAL}/pause`],
      ['POST', `/goals/${GOAL}/delete`],
      ['POST', `/goals/${GOAL}/approve`],
    ] as const) {
      const result = await call(method, pathname, method === 'GET' ? undefined : {});
      assert.equal(result.status, 404, `${method} ${pathname}`);
      assert.equal(result.body.error.code, 'NOT_FOUND');
    }
    assert.equal(foremanCalls.length, 0);
  });
});

test('only listed, valid query parameters are forwarded; anything else is dropped or refused before Foreman is called', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    const dropped = await call('GET', '/decisions?limit=5&all=1&status=pending&x=%24%7Bsecret%7D');
    assert.equal(dropped.status, 200);
    assert.equal(foremanCalls[0]!.url, 'http://foreman.test:4111/foreman/decisions?limit=5');

    for (const pathname of [
      '/decisions?limit=0',
      '/decisions?limit=201',
      '/decisions?limit=abc',
      '/decisions?sessionId=..%2Fadmin',
      '/spend?range=year',
      '/agreement?range=decade',
      '/studio-link?traceId=nothex',
      '/studio-link?traceId=',
      '/tasks?status=Run%20ning',
      '/lessons?repo=%2Fetc%2Fpasswd',
      '/decisions?limit=1&limit=2',
    ]) {
      const result = await call('GET', pathname);
      const expected = pathname === '/studio-link?traceId=' ? 200 : 400;
      assert.equal(result.status, expected, pathname);
    }
    // The empty traceId was treated as absent and forwarded without it; Foreman answers that 400 itself.
    assert.equal(foremanCalls.length, 2);
    assert.equal(foremanCalls[1]!.url, 'http://foreman.test:4111/foreman/ui/studio-link');
  });
});

test('path ids are checked: a task, inbox or lesson id with odd characters never reaches Foreman', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    for (const pathname of ['/tasks/a%20b', '/tasks/a%2Fb', `/tasks/${'x'.repeat(121)}`, '/inbox/a%3Fb/answer', '/lessons/a%23b/retire']) {
      const method = pathname.startsWith('/tasks/') ? 'GET' : 'POST';
      const result = await call(method, pathname, method === 'POST' ? { text: 'x' } : undefined);
      assert.equal(result.status, 400, pathname);
    }
    assert.equal(foremanCalls.length, 0);
  });
});

test('POST /inbox/:id/answer checks its body before calling Foreman', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { allow: 'yes' }, { reason: 'only a reason' }, { allow: true, reason: 'x'.repeat(2001) }, []]) {
      assert.equal((await call('POST', '/inbox/inb_1/answer', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(foremanCalls.length, 0);
    assert.equal((await call('POST', '/inbox/inb_1/answer', { text: 'use staging' })).status, 200);
    assert.equal((await call('POST', '/inbox/inb_1/answer', { allow: true })).status, 200);
    assert.equal(foremanCalls.length, 2);
  });
});

test('PUT /config needs a JSON object and forwards it as is', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    assert.equal((await call('PUT', '/config', [])).status, 400);
    assert.equal(foremanCalls.length, 0);
    assert.equal((await call('PUT', '/config', { mode: 'autonomous', unknownKey: 1 })).status, 200);
    assert.deepEqual(foremanCalls[0]!.body, { mode: 'autonomous', unknownKey: 1 });
  });
});

test('routes without a body do not forward the browser\'s body', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    await call('POST', '/kill', { sneaky: true });
    await call('POST', '/tasks/task-1/takeover', { sneaky: true });
    await call('POST', `/goals/${GOAL}/pause`, { sneaky: true });
    await call('POST', `/goals/${GOAL}/resume`, { sneaky: true });
    assert.deepEqual(foremanCalls.map((entry) => entry.body), [undefined, undefined, undefined, undefined]);
  });
});

test('GET /goals forwards only a valid status list and drops every other query parameter', async () => {
  await withTabRouter(ok([]), async ({ call, foremanCalls }) => {
    assert.equal((await call('GET', '/goals?status=awaiting_approval&limit=5&repo=desk&all=1')).status, 200);
    assert.equal(foremanCalls[0]!.url, 'http://foreman.test:4111/foreman/goals?status=awaiting_approval');
    assert.equal((await call('GET', '/goals')).status, 200);
    assert.equal(foremanCalls[1]!.url, 'http://foreman.test:4111/foreman/goals');
    for (const pathname of ['/goals?status=Running', '/goals?status=running,,paused', '/goals?status=running;paused', '/goals?status=a,b,c,d,e,f,g,h,i,j,k', '/goals?status=running&status=paused']) {
      assert.equal((await call('GET', pathname)).status, 400, pathname);
    }
    assert.equal(foremanCalls.length, 2);
  });
});

test('goal ids are checked: odd characters never reach Foreman', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    for (const [method, pathname] of [
      ['GET', '/goals/a%20b'],
      ['GET', `/goals/${'g'.repeat(121)}`],
      ['POST', '/goals/a%2Fb/pause'],
      ['POST', '/goals/a%3Fb/resume'],
      ['POST', '/goals/a%23b/cancel'],
      ['POST', '/goals/..%2F..%2Fkill/approve-plan'],
    ] as const) {
      const result = await call(method, pathname, method === 'POST' ? { decision: 'approve' } : undefined);
      assert.equal(result.status, 400, `${method} ${pathname}`);
      assert.equal(result.body.error.code, 'INVALID_REQUEST');
    }
    assert.equal(foremanCalls.length, 0);
  });
});

test('POST /goals checks the new goal before calling Foreman', async () => {
  const without = (key: keyof typeof NEW_GOAL) => Object.fromEntries(Object.entries(NEW_GOAL).filter(([name]) => name !== key));
  await withTabRouter(ok({ id: GOAL }), async ({ call, foremanCalls }) => {
    const bad: unknown[] = [
      [],
      {},
      without('title'),
      { ...NEW_GOAL, title: '' },
      { ...NEW_GOAL, title: '   ' },
      { ...NEW_GOAL, title: 'x'.repeat(201) },
      without('description'),
      { ...NEW_GOAL, description: 'x'.repeat(20_001) },
      without('repos'),
      { ...NEW_GOAL, repos: [] },
      { ...NEW_GOAL, repos: 'desk' },
      { ...NEW_GOAL, repos: ['../etc'] },
      { ...NEW_GOAL, repos: [5] },
      { ...NEW_GOAL, repos: Array.from({ length: 21 }, (_, index) => `repo${index}`) },
      without('budgetUsd'),
      { ...NEW_GOAL, budgetUsd: 0 },
      { ...NEW_GOAL, budgetUsd: -1 },
      { ...NEW_GOAL, budgetUsd: 1000.01 },
      { ...NEW_GOAL, budgetUsd: '5' },
      { ...NEW_GOAL, constraints: 'x'.repeat(5001) },
      { ...NEW_GOAL, constraints: 5 },
      { ...NEW_GOAL, deadline: 'tomorrow' },
      { ...NEW_GOAL, deadline: '2026-12-01' },
      { ...NEW_GOAL, deadline: '2026-13-45T00:00:00Z' },
      { ...NEW_GOAL, requirePlanApproval: 'yes' },
      { ...NEW_GOAL, owner: 'someone' },
    ];
    for (const body of bad) {
      const result = await call('POST', '/goals', body);
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(result.body.error.code, 'INVALID_REQUEST');
    }
    assert.equal(foremanCalls.length, 0);
    assert.equal((await call('POST', '/goals', { ...NEW_GOAL, owner: 'someone' })).body.error.message, 'Unknown field: owner.');
    assert.match((await call('POST', '/goals', { ...NEW_GOAL, budgetUsd: 0 })).body.error.message, /budgetUsd/);

    const minimal = { title: 'Fix it', description: 'All of it.', repos: ['desk'], budgetUsd: 1000 };
    assert.equal((await call('POST', '/goals', minimal)).status, 200);
    assert.equal((await call('POST', '/goals', { ...NEW_GOAL, deadline: '2026-12-01T17:00+01:00', requirePlanApproval: false })).status, 200);
    assert.deepEqual(foremanCalls.map((entry) => entry.body), [minimal, { ...NEW_GOAL, deadline: '2026-12-01T17:00+01:00', requirePlanApproval: false }]);
  });
});

test('POST /goals/:id/approve-plan takes approve, approve with a note, revise with a note, or reject, and refuses anything else', async () => {
  await withTabRouter(ok({ id: GOAL }), async ({ call, foremanCalls }) => {
    const bad: unknown[] = [
      {},
      [],
      { decision: 'maybe' },
      { decision: 5 },
      { decision: 'revise' },
      { decision: 'revise', note: '   ' },
      { approve: 'yes' },
      { note: 'just a note' },
      { decision: 'approve', approve: false },
      { decision: 'reject', approve: true },
      { decision: 'revise', approve: true, note: 'x' },
      { decision: 'approve', note: 'x'.repeat(5001) },
      { decision: 'approve', extra: 1 },
    ];
    for (const body of bad) {
      assert.equal((await call('POST', `/goals/${GOAL}/approve-plan`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(foremanCalls.length, 0);
    assert.match((await call('POST', `/goals/${GOAL}/approve-plan`, { decision: 'revise' })).body.error.message, /note/);

    const good = [
      { decision: 'approve' },
      { approve: true },
      { approve: false },
      { decision: 'approve', approve: true, note: 'keep the old endpoint' },
      { decision: 'revise', note: 'split the migration into its own milestone' },
      { decision: 'reject' },
      { decision: 'reject', approve: false, note: 'not this quarter' },
    ];
    for (const body of good) {
      assert.equal((await call('POST', `/goals/${GOAL}/approve-plan`, body)).status, 200, JSON.stringify(body));
    }
    assert.deepEqual(foremanCalls.map((entry) => entry.body), good);
  });
});

test('POST /goals/:id/cancel takes an optional short reason and always sends Foreman a JSON object', async () => {
  await withTabRouter(ok({ id: GOAL }), async ({ call, foremanCalls }) => {
    for (const body of [[], { reason: 5 }, { reason: 'x'.repeat(501) }, { why: 'x' }]) {
      assert.equal((await call('POST', `/goals/${GOAL}/cancel`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(foremanCalls.length, 0);
    assert.equal((await call('POST', `/goals/${GOAL}/cancel`)).status, 200);
    assert.equal((await call('POST', `/goals/${GOAL}/cancel`, { reason: 'x'.repeat(500) })).status, 200);
    assert.deepEqual(foremanCalls.map((entry) => entry.body), [{}, { reason: 'x'.repeat(500) }]);
  });
});

test('the inbox answer route takes every answer a goal item needs (plan, budget, question)', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    const answers = [{ allow: true }, { allow: true, text: 'keep the old endpoint' }, { allow: false, text: 'not now' }, { text: 'split the migration' }, { text: 'fail' }, { text: 'extend' }, { allow: false }];
    for (const body of answers) {
      assert.equal((await call('POST', `/inbox/inb_${GOAL}_1/answer`, body)).status, 200, JSON.stringify(body));
    }
    assert.deepEqual(foremanCalls.map((entry) => entry.body), answers);
    assert.equal(foremanCalls[0]!.url, `http://foreman.test:4111/foreman/inbox/inb_${GOAL}_1/answer`);
  });
});

test('Foreman\'s 201 for a new goal reaches the browser as a success; a 2xx without JSON is still a 502', async () => {
  const created = { id: GOAL, title: NEW_GOAL.title, status: 'planning' };
  await withTabRouter((entry) => (entry.method === 'POST' && entry.url.endsWith('/foreman/goals') ? { status: 201, json: created } : { status: 204, json: undefined }), async ({ call }) => {
    const result = await call('POST', '/goals', NEW_GOAL);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { success: true, data: created });
    const empty = await call('POST', `/goals/${GOAL}/pause`);
    assert.equal(empty.status, 502);
    assert.equal(empty.body.error.code, 'FOREMAN_ERROR');
  });
});

test('Foreman\'s refusals of goal calls reach the browser: 400 with its issues, 404, and 409 with its message', async () => {
  const issues = [{ path: ['repos', 0], message: 'Unknown repo: nope' }];
  await withTabRouter(
    (entry) =>
      entry.url.endsWith('/foreman/goals')
        ? { status: 400, json: { error: 'The goal is invalid.', issues } }
        : entry.url.endsWith('/approve-plan')
          ? { status: 409, json: { error: 'The goal is not awaiting approval.' } }
          : { status: 404, json: { error: 'goal not found' } },
    async ({ call }) => {
      const refused = await call('POST', '/goals', { ...NEW_GOAL, repos: ['nope'] });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, 'FOREMAN_REJECTED');
      assert.deepEqual(refused.body.error.details.issues, issues);
      const conflict = await call('POST', `/goals/${GOAL}/approve-plan`, { decision: 'approve' });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'CONFLICT');
      assert.equal(conflict.body.error.message, 'The goal is not awaiting approval.');
      const missing = await call('GET', `/goals/${GOAL}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'goal not found');
    },
  );
});

test('Foreman\'s refusal of a settings change reaches the browser with its per-field messages', async () => {
  const fieldErrors = { 'budgets.perDayUsd': 'Too small: expected number to be >0', mode: 'Invalid option' };
  await withTabRouter(() => ({ status: 400, json: { error: 'The config is invalid.', fieldErrors } }), async ({ call }) => {
    const result = await call('PUT', '/config', { budgets: { perDayUsd: -1 } });
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error.code, 'FOREMAN_REJECTED');
    assert.equal(result.body.error.message, 'The config is invalid.');
    assert.deepEqual(result.body.error.details.fieldErrors, fieldErrors);
  });
});

test('Foreman\'s 404 and 409 become cloudcli errors; other failures are a 502', async () => {
  await withTabRouter((call) => (call.url.includes('/tasks/') ? { status: 404, json: { error: 'task not found' } } : call.url.endsWith('/kill') ? { status: 409, json: { error: 'already killed' } } : { status: 500, json: { error: 'boom' } }), async ({ call }) => {
    const missing = await call('GET', '/tasks/task-9');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.equal(missing.body.error.message, 'task not found');
    assert.equal((await call('POST', '/kill')).status, 409);
    const broken = await call('GET', '/overview');
    assert.equal(broken.status, 502);
    assert.equal(broken.body.error.code, 'FOREMAN_ERROR');
  });
});

test('Foreman being down is a 502 FOREMAN_UNAVAILABLE', async () => {
  await withTabRouter(() => 'down', async ({ call }) => {
    const result = await call('GET', '/overview');
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'FOREMAN_UNAVAILABLE');
  });
});

test('with no bridge token file every route answers 503 instead of calling Foreman', async () => {
  await withTabRouter(ok(), async ({ call, foremanCalls }) => {
    const result = await call('GET', '/overview');
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'FOREMAN_BRIDGE_DISABLED');
    assert.equal(foremanCalls.length, 0);
  }, { token: null });
});

test('answers are never cached', async () => {
  await withTabRouter(ok(), async ({ call }) => {
    assert.equal((await call('GET', '/overview')).headers.get('cache-control'), 'no-store');
    assert.equal((await call('GET', '/nowhere')).headers.get('cache-control'), 'no-store');
  });
});

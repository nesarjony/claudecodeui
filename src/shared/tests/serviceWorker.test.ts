import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, vi } from 'vitest';

/**
 * The service worker's fetch handler answered a failed network request with
 * whatever `caches.match()` returned, which is `undefined` for anything not
 * cached. `respondWith(undefined)` fails with "Failed to convert value to
 * 'Response'". These tests run the real `public/sw.js` against stand-ins for
 * the worker globals.
 */

const ORIGIN = 'https://cloud.example.test';
const SOURCE = readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

type FakeRequest = { url: string; method: string; mode: string };
type FetchEvent = { request: FakeRequest; respondWith: (response: unknown) => void };

function loadServiceWorker(options: {
  fetch: (request: FakeRequest) => Promise<Response>;
  cached?: Record<string, Response>;
}) {
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const cache = { put: vi.fn(async () => {}), addAll: vi.fn(async () => {}) };
  const caches = {
    match: vi.fn(async (request: FakeRequest) => options.cached?.[request.url]),
    open: vi.fn(async () => cache),
    keys: async () => [],
    delete: async () => true,
  };
  const workerSelf = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  new Function('self', 'caches', 'fetch', 'Response', SOURCE)(workerSelf, caches, options.fetch, Response);

  const dispatch = (url: string, init: Partial<FakeRequest> = {}) => {
    let answer: Promise<unknown> | null = null;
    listeners.get('fetch')!({
      request: { url, method: 'GET', mode: 'cors', ...init },
      respondWith: (response) => {
        answer = Promise.resolve(response);
      },
    });
    return answer as Promise<unknown> | null;
  };

  return { dispatch, cache };
}

const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

describe('service worker fetch handler', () => {
  it('answers a failed request for something not cached with a network error, not undefined', async () => {
    const { dispatch } = loadServiceWorker({ fetch: offline });

    const response = await dispatch(`${ORIGIN}/health`);

    assert.ok(response instanceof Response);
    assert.equal(response.type, 'error');
  });

  it('serves the cached copy when the network fails and one exists', async () => {
    const manifest = new Response('{}', { status: 200 });
    const { dispatch } = loadServiceWorker({
      fetch: offline,
      cached: { [`${ORIGIN}/manifest.json`]: manifest },
    });

    assert.equal(await dispatch(`${ORIGIN}/manifest.json`), manifest);
  });

  it('answers a failed asset fetch with a network error and caches nothing', async () => {
    const { dispatch, cache } = loadServiceWorker({ fetch: offline });

    const response = await dispatch(`${ORIGIN}/assets/index-B4rWPG2O.js`);

    assert.ok(response instanceof Response);
    assert.equal(response.type, 'error');
    assert.equal(cache.put.mock.calls.length, 0);
  });

  it('does not cache an asset the server could not find', async () => {
    const { dispatch, cache } = loadServiceWorker({
      fetch: async () => new Response('not found', { status: 404 }),
    });

    const response = await dispatch(`${ORIGIN}/assets/index-missing.js`);

    assert.equal((response as Response).status, 404);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cache.put.mock.calls.length, 0);
  });

  it('leaves writes, API calls, sockets and other origins to the network', () => {
    const { dispatch } = loadServiceWorker({ fetch: offline });

    assert.equal(dispatch(`${ORIGIN}/manifest.json`, { method: 'POST' }), null);
    assert.equal(dispatch(`${ORIGIN}/api/projects`), null);
    assert.equal(dispatch(`${ORIGIN}/ws?token=redacted`), null);
    assert.equal(dispatch('https://api.github.com/repos/siteboon/claudecodeui'), null);
  });
});

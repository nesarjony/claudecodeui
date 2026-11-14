import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  bridgeTokenMatches,
  createBridgeAuthMiddleware,
  extractBearerToken,
  readBridgeToken,
  resolveBridgeTokenFile,
  resolveEventsTokenFile,
  warnAboutTokenSetup,
} from '@/modules/foreman/foreman-auth.service.js';
import { AppError } from '@/shared/utils.js';

async function withTokenFile(
  contents: string | null,
  run: (tokenFile: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-auth-'));
  const tokenFile = path.join(directory, 'bridge-token');
  try {
    if (contents !== null) {
      await writeFile(tokenFile, contents, { mode: 0o600 });
    }
    await run(tokenFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withGuardedServer(
  tokenFile: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/guarded', createBridgeAuthMiddleware({ tokenFile }), (_request, response) => {
    response.json({ reached: true });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error as AppError;
    response.status(appError.statusCode).json({ code: appError.code });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the token file defaults to ~/.config/foreman/bridge-token and can be overridden', () => {
  assert.equal(resolveBridgeTokenFile({}, '/home/nesar'), '/home/nesar/.config/foreman/bridge-token');
  assert.equal(
    resolveBridgeTokenFile({ FOREMAN_BRIDGE_TOKEN_FILE: '/run/secrets/bridge' }, '/home/nesar'),
    '/run/secrets/bridge',
  );
});

test('the intake token file is only what FOREMAN_EVENTS_TOKEN_FILE names: it never falls back to the bridge token file', () => {
  assert.equal(resolveEventsTokenFile({}), undefined);
  assert.equal(resolveEventsTokenFile({ FOREMAN_EVENTS_TOKEN_FILE: '   ' }), undefined);
  assert.equal(resolveEventsTokenFile({ FOREMAN_BRIDGE_TOKEN_FILE: '/run/secrets/bridge' }), undefined);
  assert.equal(resolveEventsTokenFile({ FOREMAN_EVENTS_TOKEN_FILE: ' /run/secrets/intake ' }), '/run/secrets/intake');
});

test('boot says that nothing is pushed, naming the variable, only while no intake token file is set', () => {
  const warnings: string[] = [];
  warnAboutTokenSetup({ bridgeTokenFile: '/nonexistent/bridge-token', eventsTokenFile: undefined }, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /FOREMAN_EVENTS_TOKEN_FILE is not set/);
  assert.match(warnings[0] ?? '', /not pushed/);

  const none: string[] = [];
  warnAboutTokenSetup({ bridgeTokenFile: '/nonexistent/bridge-token', eventsTokenFile: '/nonexistent/intake-token' }, (message) => none.push(message));
  assert.deepEqual(none, [], 'a token file that does not exist is reported where it is needed, not here');
});

test('a token file that group or others can reach is warned about, by path and mode and never by content; a private one is not', async () => {
  await withTokenFile('s3cret-token', async (tokenFile) => {
    for (const [mode, warns] of [[0o600, false], [0o400, false], [0o644, true], [0o660, true], [0o602, true]] as const) {
      await chmod(tokenFile, mode);
      const warnings: string[] = [];
      warnAboutTokenSetup({ bridgeTokenFile: tokenFile, eventsTokenFile: tokenFile }, (message) => warnings.push(message));
      assert.equal(warnings.length, warns ? 1 : 0, `mode ${mode.toString(8)} (one file named twice is one warning)`);
      if (warns) {
        assert.ok(warnings[0]?.includes(tokenFile) && warnings[0].includes(mode.toString(8)));
        assert.ok(!warnings[0]?.includes('s3cret-token'), 'the token is not printed');
      }
    }
  });
});

test('each of the two token files is checked on its own', async () => {
  await withTokenFile('bridge-secret', async (bridgeTokenFile) => {
    await withTokenFile('intake-secret', async (eventsTokenFile) => {
      await chmod(bridgeTokenFile, 0o600);
      await chmod(eventsTokenFile, 0o644);
      const warnings: string[] = [];
      warnAboutTokenSetup({ bridgeTokenFile, eventsTokenFile }, (message) => warnings.push(message));
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]?.includes(eventsTokenFile));
    });
  });
});

test('the token is the trimmed file content, and a missing or blank file means no token', async () => {
  await withTokenFile('  s3cret-token\n', async (tokenFile) => {
    assert.equal(await readBridgeToken(tokenFile), 's3cret-token');
  });
  await withTokenFile('   \n', async (tokenFile) => {
    assert.equal(await readBridgeToken(tokenFile), null);
  });
  await withTokenFile(null, async (tokenFile) => {
    assert.equal(await readBridgeToken(tokenFile), null);
  });
});

test('bearer extraction accepts only a well-formed Bearer header', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('Bearer   abc123  '), 'abc123');
  assert.equal(extractBearerToken('Basic abc123'), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer a b'), null);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(['Bearer abc']), null);
});

test('token comparison matches only the identical token, whatever the length', () => {
  assert.equal(bridgeTokenMatches('s3cret', 's3cret'), true);
  assert.equal(bridgeTokenMatches('s3cret', 's3creT'), false);
  assert.equal(bridgeTokenMatches('s3cret', 's3cret-longer'), false);
  assert.equal(bridgeTokenMatches('s3cret', 's'), false);
  assert.equal(bridgeTokenMatches('s3cret', ''), false);
});

test('with no token file every request is refused with 503 and never reaches the route', async () => {
  await withTokenFile(null, async (tokenFile) => {
    await withGuardedServer(tokenFile, async (baseUrl) => {
      const anonymous = await fetch(`${baseUrl}/guarded`);
      assert.equal(anonymous.status, 503);
      assert.deepEqual(await anonymous.json(), { code: 'FOREMAN_BRIDGE_DISABLED' });

      // Even a request that presents some token is refused: there is nothing to compare it with.
      const withHeader = await fetch(`${baseUrl}/guarded`, { headers: { authorization: 'Bearer anything' } });
      assert.equal(withHeader.status, 503);
    });
  });
});

test('a blank token file disables the bridge too', async () => {
  await withTokenFile('\n', async (tokenFile) => {
    await withGuardedServer(tokenFile, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/guarded`)).status, 503);
    });
  });
});

test('a missing, malformed or wrong bearer token is refused with 401', async () => {
  await withTokenFile('right-token', async (tokenFile) => {
    await withGuardedServer(tokenFile, async (baseUrl) => {
      for (const headers of [
        {},
        { authorization: 'Bearer wrong-token' },
        { authorization: 'Basic right-token' },
        { authorization: 'right-token' },
        { authorization: 'Bearer ' },
      ] as Array<Record<string, string>>) {
        const response = await fetch(`${baseUrl}/guarded`, { headers });
        assert.equal(response.status, 401, JSON.stringify(headers));
        assert.deepEqual(await response.json(), { code: 'FOREMAN_BRIDGE_UNAUTHORIZED' });
      }
    });
  });
});

test('the right bearer token reaches the route', async () => {
  await withTokenFile('right-token\n', async (tokenFile) => {
    await withGuardedServer(tokenFile, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/guarded`, { headers: { authorization: 'Bearer right-token' } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { reached: true });
    });
  });
});

test('the token is re-read for every request, so rotating the file needs no restart', async () => {
  await withTokenFile('first-token', async (tokenFile) => {
    await withGuardedServer(tokenFile, async (baseUrl) => {
      const call = (token: string) => fetch(`${baseUrl}/guarded`, { headers: { authorization: `Bearer ${token}` } });

      assert.equal((await call('first-token')).status, 200);
      await writeFile(tokenFile, 'second-token');
      assert.equal((await call('first-token')).status, 401);
      assert.equal((await call('second-token')).status, 200);
    });
  });
});

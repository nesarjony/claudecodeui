import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSandboxAdditions } from '@/modules/foreman/foreman-sandbox.service.js';

import { SAMPLE_SCOPE, samplePolicy } from './foreman-sandbox-support.js';

// Kernel views, not storage: nothing a worker connects to as a service of the host lives there.
const PSEUDO_FILESYSTEMS = ['/proc', '/sys', '/dev'];

/** Every unix socket file under `root` that is not inside one of the `skipped` trees. The walk passes over a directory it may not read. */
function socketsOutside(root: string, skipped: string[]): string[] {
  const inSkipped = skipped.flatMap((tree, index) => [...(index === 0 ? [] : ['-o']), '-path', tree]);
  const found = spawnSync('find', [root, '(', ...inSkipped, ')', '-prune', '-o', '-type', 's', '-print'], { encoding: 'utf8' });
  assert.equal(found.error, undefined, 'find could not run');
  return found.stdout.split('\n').filter(Boolean).sort();
}

/** The sandbox's own forced list: what `denyRead` holds when the policy denies nothing itself. */
function hiddenTrees(): string[] {
  const policy = samplePolicy({ filesystem: { ...samplePolicy().filesystem, denyRead: [] } });
  return (buildSandboxAdditions(policy, SAMPLE_SCOPE, () => undefined).sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
}

test('the listing finds a socket outside the skipped trees and passes over one inside them', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sockets-'));
  mkdirSync(path.join(root, 'open'));
  mkdirSync(path.join(root, 'hidden'));
  const servers = [path.join(root, 'open/a.sock'), path.join(root, 'hidden/b.sock')].map((socket) => createServer().listen(socket));
  try {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.once('listening', resolve))));
    assert.deepEqual(socketsOutside(root, [path.join(root, 'hidden')]), [path.join(root, 'open/a.sock')]);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  }
});

// With every unix socket allowed, a socket a worker can see is one it can connect to (HIDDEN_TREES in foreman-sandbox.service.ts). This host's
// sockets are what that list was made from, and a service installed later can put one somewhere new: then this test names it. It tests the
// machine, not the code, so it runs only where asked (`CLOUDCLI_HOST_CHECKS=1`): on the host that runs workers, as a step of the cutover checks.
test('every unix socket on this host lies under a hidden tree', { skip: process.env.CLOUDCLI_HOST_CHECKS !== '1' && 'a host check: set CLOUDCLI_HOST_CHECKS=1' }, () => {
  assert.deepEqual(socketsOutside('/', [...PSEUDO_FILESYSTEMS, ...hiddenTrees()]), [], 'a worker could connect to these: add their tree to HIDDEN_TREES');
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { quickCommandsService } from '@/modules/quick-commands/quick-commands.service.js';

const USER_ID = 1;

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'quick-commands-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('quick commands persist CRUD, ordering, and settings per user', async () => {
  await withDatabase(() => {
    const first = quickCommandsService.create(USER_ID, 'Review', 'review this', '🔎', 'done', true, null);
    const second = quickCommandsService.create(USER_ID, 'Test', 'run tests', null, null, false, null);

    assert.deepEqual(quickCommandsService.list(USER_ID).commands.map((command) => command.id), [first.id, second.id]);
    quickCommandsService.reorder(USER_ID, [second.id, first.id]);
    assert.deepEqual(quickCommandsService.list(USER_ID).commands.map((command) => command.id), [second.id, first.id]);

    const updated = quickCommandsService.update(USER_ID, first.id, { body: 'review carefully', pinned: 0 });
    assert.equal(updated?.body, 'review carefully');
    assert.equal(updated?.pinned, 0);

    const settings = quickCommandsService.saveSettings(USER_ID, { mode: 'llm', model: 'sonnet', send_mode: 'direct' });
    assert.equal(settings.mode, 'llm');
    assert.equal(settings.model, 'sonnet');
    assert.equal(settings.send_mode, 'direct');

    assert.equal(quickCommandsService.remove(USER_ID, second.id), true);
    assert.deepEqual(quickCommandsService.list(USER_ID).commands.map((command) => command.id), [first.id]);
  });
});

test('quick command settings reject unsupported values', async () => {
  await withDatabase(() => {
    assert.throws(
      () => quickCommandsService.saveSettings(USER_ID, { model: 'unknown' }),
      /invalid model/,
    );
  });
});

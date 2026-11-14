import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, foremanHandoverGrantsDb, foremanRunModesDb, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

/** The storage of the Foreman hand-over against a real database: the owners' grants and the mode each session last ran in. */

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'foreman-handover-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const columnsOf = (table: string) => (getConnection().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>).map((column) => [column.name, column.pk]);
const grant = (sessionId: string, expiresAt: string, grantedBy = 'nesar') => ({ session_id: sessionId, granted_by: grantedBy, created_at: '2026-11-14T09:00:00.000Z', expires_at: expiresAt });
const grantRows = () => getConnection().prepare('SELECT * FROM foreman_handover_grants ORDER BY session_id').all();

test('the grants and run modes tables are made at init and by the migrations of a database that predates them', async () => {
  await withDatabase(() => {
    const expected = {
      foreman_handover_grants: [['session_id', 1], ['granted_by', 0], ['created_at', 0], ['expires_at', 0]],
      foreman_run_modes: [['session_id', 1], ['permission_mode', 0], ['seen_at', 0]],
    };
    for (const [table, columns] of Object.entries(expected)) {
      assert.deepEqual(columnsOf(table), columns, table);
      getConnection().exec(`DROP TABLE ${table}`);
    }
    runMigrations(getConnection());
    for (const [table, columns] of Object.entries(expected)) {
      assert.deepEqual(columnsOf(table), columns, `${table} after the migrations`);
    }
  });
});

test('the run mode of a session is the one its last run started in', async () => {
  await withDatabase(() => {
    assert.equal(foremanRunModesDb.get('owner'), null);
    foremanRunModesDb.record('owner', 'default', '2026-11-14T09:00:00.000Z');
    foremanRunModesDb.record('worker', 'plan', '2026-11-14T09:01:00.000Z');
    foremanRunModesDb.record('owner', 'acceptEdits', '2026-11-14T09:02:00.000Z');
    assert.deepEqual(foremanRunModesDb.get('owner'), { session_id: 'owner', permission_mode: 'acceptEdits', seen_at: '2026-11-14T09:02:00.000Z' });
    assert.equal(foremanRunModesDb.get('worker')?.permission_mode, 'plan');
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM foreman_run_modes').get() as { count: number }).count, 2);
  });
});

test('a grant replaces the older one of its session, is used once while it is valid, and never after it expired', async () => {
  await withDatabase(() => {
    foremanHandoverGrantsDb.put(grant('s1', '2026-11-14T09:05:00.000Z', 'first'));
    foremanHandoverGrantsDb.put(grant('s1', '2026-11-14T09:07:00.000Z', 'second'));
    assert.deepEqual(grantRows(), [grant('s1', '2026-11-14T09:07:00.000Z', 'second')]);

    assert.equal(foremanHandoverGrantsDb.consume('s2', '2026-11-14T09:01:00.000Z'), false, 'no grant for that session');
    assert.equal(foremanHandoverGrantsDb.consume('s1', '2026-11-14T09:07:00.000Z'), false, 'expired at its expiry');
    assert.equal(grantRows().length, 1, 'an expired grant is left for the purge');
    assert.equal(foremanHandoverGrantsDb.consume('s1', '2026-11-14T09:06:59.999Z'), true);
    assert.equal(foremanHandoverGrantsDb.consume('s1', '2026-11-14T09:06:59.999Z'), false, 'used once');
    assert.deepEqual(grantRows(), []);
  });
});

test('revoke withdraws a grant, valid or not, and the purge drops only the expired ones', async () => {
  await withDatabase(() => {
    foremanHandoverGrantsDb.put(grant('valid', '2026-11-14T09:05:00.000Z'));
    foremanHandoverGrantsDb.put(grant('expired', '2026-11-14T08:59:00.000Z'));
    foremanHandoverGrantsDb.put(grant('now', '2026-11-14T09:00:00.000Z'));
    assert.equal(foremanHandoverGrantsDb.purgeExpired('2026-11-14T09:00:00.000Z'), 2);
    assert.deepEqual(grantRows(), [grant('valid', '2026-11-14T09:05:00.000Z')]);
    assert.equal(foremanHandoverGrantsDb.revoke('valid'), true);
    assert.equal(foremanHandoverGrantsDb.revoke('valid'), false);
    assert.deepEqual(grantRows(), []);
  });
});

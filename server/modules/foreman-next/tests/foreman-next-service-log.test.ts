import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createForemanNextRouter } from '@/modules/foreman-next/foreman-next.module.js';
import { redactSecrets } from '@/modules/foreman-next/foreman-next.redact.js';
import { createServiceLog, MAX_LOG_BYTES, MAX_LOG_LINES } from '@/modules/foreman-next/foreman-next.service-log.js';

const TOKEN = 'proxy-token-0123456789abcdef';

/** A stand-in for journalctl: it records the arguments it was started with and prints what a test gives it, or fails as a test says. */
async function fakeJournal(directory: string, body: string, name = 'journalctl') {
  const command = path.join(directory, name);
  await writeFile(command, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(directory, 'argv')}"\n${body}\n`);
  await chmod(command, 0o755);
  return { command, argv: async () => (await readFile(path.join(directory, 'argv'), 'utf8')).split('\n').filter((line) => line !== '') };
}

/** The router over a service log, asked the way the panel asks. */
async function panelOver(serviceLog: ReturnType<typeof createServiceLog>) {
  const app = express();
  app.use('/api/foreman-next', createForemanNextRouter({ client: { forward: async () => null }, serviceLog }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/foreman-next/service-log`;
  return { lines: async () => ((await (await fetch(url)).json()) as { success: boolean; data: string[] }).data, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const logOf = (command: string, secrets: string[] = []) => createServiceLog({ file: undefined, journalCommand: command, unit: 'foreman-next', secrets: async () => secrets });

test('reads the last lines of the foreman-next user journal, with arguments and no shell, and sends them as the panel\'s lines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-journal-'));
  // A name a shell would take apart: it runs only if the command is started as one program with its arguments.
  const journal = await fakeJournal(directory, "printf '%s\\n' '2026-11-15T18:00:00+0600 foreman-next[7]: listening on 4211' '2026-11-15T18:00:01+0600 foreman-next[7]: a goal began'", 'journalctl; touch shell-ran');
  const panel = await panelOver(logOf(journal.command));
  try {
    assert.deepEqual(await panel.lines(), ['2026-11-15T18:00:00+0600 foreman-next[7]: listening on 4211', '2026-11-15T18:00:01+0600 foreman-next[7]: a goal began']);
    assert.deepEqual(await journal.argv(), ['--user', '--unit', 'foreman-next', '--lines', String(MAX_LOG_LINES), '--no-pager', '--quiet', '--no-hostname', '--output', 'short-iso']);
    await assert.rejects(stat(path.join(directory, 'shell-ran')), { code: 'ENOENT' });
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('takes the proxy\'s own token and anything shaped like a bearer token or a key out of the lines before they are sent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-journal-'));
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const commit = '3f786850e387550fdab836ed7e6dc881de23001b';
  const journal = await fakeJournal(
    directory,
    [
      "printf '%s\\n'",
      `'foreman-next[7]: call failed with Authorization: Bearer ${TOKEN}'`,
      "'foreman-next[7]: Authorization: Bearer opaque-credential-value'",
      `'foreman-next[7]: the intake answered 401 for /events?t=${TOKEN}&x=1'`,
      "'foreman-next[7]: env ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz MINIMAX_API_KEY=\"plain value\"'",
      `'foreman-next[7]: {\"token\": \"${hex}\", \"ok\": true}'`,
      `'foreman-next[7]: CLOUDCLI_INTAKE_TOKEN: ${hex}'`,
      "'foreman-next[7]: password=hunter2 user=nesar'",
      "'foreman-next[7]: github ghp_abcdefghijklmnopqrstuvwxyz0123456789 and a jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'",
      `'foreman-next[7]: integrated ${commit} into goal/branch, token guard refused nothing'`,
    ].join(' '),
  );
  const panel = await panelOver(logOf(journal.command, [TOKEN]));
  try {
    const sent = await panel.lines();
    const everything = sent.join('\n');
    for (const secret of [TOKEN, 'opaque-credential-value', 'sk-ant-api03', 'plain value', hex, 'hunter2', 'ghp_', 'eyJhbGci', 'c2lnbmF0dXJl']) assert.ok(!everything.includes(secret), `${secret} must not be sent`);
    assert.equal(sent.length, 9);
    assert.ok(sent[0]?.endsWith('call failed with Authorization: [redacted]'), sent[0]);
    assert.ok(sent[2]?.includes('/events?t=[redacted]&x=1'), sent[2]);
    // What is not a secret stays readable: a commit id is 40 digits, and the word token alone says nothing.
    assert.ok(sent[8]?.includes(commit) && sent[8].includes('token guard refused nothing'), sent[8]);
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('caps the answer: the last 400 lines, no line over 2000 characters, and no more than 64 KiB in all', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-journal-'));
  const many = await fakeJournal(directory, 'i=1; while [ $i -le 1000 ]; do echo "line $i"; i=$((i+1)); done');
  const lines = await logOf(many.command)();
  assert.equal(lines.length, MAX_LOG_LINES);
  assert.equal(lines.at(0), 'line 601');
  assert.equal(lines.at(-1), 'line 1000');

  const wide = await fakeJournal(directory, 'echo first; head -c 100000 /dev/zero | tr "\\0" x; echo; echo last');
  const capped = await logOf(wide.command)();
  assert.deepEqual([capped.at(0), capped.at(-1)], ['first', 'last']);
  assert.equal(capped[1]?.length, 2000);

  const heavy = await fakeJournal(directory, 'i=1; while [ $i -le 400 ]; do head -c 1900 /dev/zero | tr "\\0" y; echo; i=$((i+1)); done; echo newest');
  const bounded = await logOf(heavy.command)();
  assert.ok(bounded.join('\n').length <= MAX_LOG_BYTES, 'the answer stays within the byte cap');
  assert.equal(bounded.at(-1), 'newest', 'the newest lines are the ones kept');
  assert.ok(bounded.length < MAX_LOG_LINES);
  await rm(directory, { recursive: true, force: true });
});

test('says when there is no journal, instead of an empty log: no journalctl, a journalctl that fails, and an empty journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-journal-'));
  try {
    assert.deepEqual(await logOf(path.join(directory, 'no-such-journalctl'))(), ['No journal is available: journalctl is not installed here.']);

    const failing = await fakeJournal(directory, 'echo "Failed to open journal: Permission denied" >&2; exit 1');
    assert.deepEqual(await logOf(failing.command)(), ['No journal is available: journalctl failed (exit 1): Failed to open journal: Permission denied.']);

    const empty = await fakeJournal(directory, 'exit 0');
    const [said] = await logOf(empty.command)();
    assert.ok(said?.startsWith('No journal is available: the journal holds nothing for foreman-next'), said);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads the file instead when FOREMAN_NEXT_LOG_FILE names one, the way a test instance logs, with the same cleaning and an empty log for a file not yet written', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-journal-'));
  const file = path.join(directory, 'server.log');
  await writeFile(file, ['one', `two Bearer ${TOKEN}`, 'three'].join('\n'));
  const fileLog = (target: string) => createServiceLog({ file: target, journalCommand: path.join(directory, 'never-run'), unit: 'foreman-next', secrets: async () => [TOKEN] });
  try {
    assert.deepEqual(await fileLog(file)(), ['one', 'two Bearer [redacted]', 'three']);
    assert.deepEqual(await fileLog(path.join(directory, 'none.log'))(), []);

    // A file longer than the cap is read from its end, and the line the cut fell in is dropped, so no piece of a token is shown.
    await writeFile(file, `${'z'.repeat(MAX_LOG_BYTES)}\nlast line\n`);
    assert.deepEqual(await fileLog(file)(), ['last line']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('redacts by shape and by value, and leaves ordinary words and short values alone', () => {
  assert.equal(redactSecrets('x Bearer abc.def-ghi y', []), 'x Bearer [redacted] y');
  assert.equal(redactSecrets('the bearer of news, and a basic setup', []), 'the bearer of news, and a basic setup');
  assert.equal(redactSecrets('FOREMAN_API_TOKEN=abc123 next', []), 'FOREMAN_API_TOKEN=[redacted] next');
  assert.equal(redactSecrets('api_key: "two words" done', []), 'api_key: [redacted] done');
  assert.equal(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA== sent', []), 'Authorization: [redacted] sent');
  assert.equal(redactSecrets(`value ${TOKEN} twice ${TOKEN}`, [TOKEN]), 'value [redacted] twice [redacted]');
  // A secret shorter than a token the guard accepts is not replaced as a value: it would eat ordinary text.
  assert.equal(redactSecrets('a short word and a short word', ['short']), 'a short word and a short word');
  assert.equal(redactSecrets('the token guard refused: nothing here', []), 'the token guard refused: nothing here');
  assert.equal(redactSecrets('abc123def', []), 'abc123def');
});

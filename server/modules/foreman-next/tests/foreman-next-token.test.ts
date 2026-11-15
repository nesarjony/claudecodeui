import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { format } from 'node:util';

import { readTokenFile } from '@/modules/foreman-next/foreman-next.token.js';

const HEX_TOKEN = '0123456789abcdef'.repeat(4);
const NAMED_TOKEN = 'api-token-0123456789abc';

const directories: string[] = [];
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A fresh directory per case, since what the module has already said is remembered by file path. */
async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foreman-next-token-'));
  directories.push(directory);
  return directory;
}

async function tokenFile(content: string, mode = 0o600): Promise<string> {
  const file = path.join(await freshDirectory(), 'next-api-token');
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

/** Reads the file with `console.error` recorded (and silent): the token, or null, and what was logged, one string per call. */
async function readAndLog(file: string): Promise<{ token: string | null; lines: string[] }> {
  const spy = mock.method(console, 'error', () => undefined);
  try {
    const token = await readTokenFile(file);
    return { token, lines: spy.mock.calls.map((call) => format(...call.arguments)) };
  } finally {
    spy.mock.restore();
  }
}

const VALID: Array<[name: string, content: string, token: string]> = [
  ['64 hex characters', HEX_TOKEN, HEX_TOKEN],
  ['a test token', NAMED_TOKEN, NAMED_TOKEN],
  ['with one trailing \\n', `${HEX_TOKEN}\n`, HEX_TOKEN],
  ['with one trailing \\r\\n', `${NAMED_TOKEN}\r\n`, NAMED_TOKEN],
  ['every allowed symbol', 'Az09-._~+/=Az09-._~+/=', 'Az09-._~+/=Az09-._~+/='],
  ['the shortest, 16 characters', 'a'.repeat(16), 'a'.repeat(16)],
  ['the longest, 512 characters, with \\r\\n', `${'a'.repeat(512)}\r\n`, 'a'.repeat(512)],
];

const INVALID: Array<[name: string, content: string]> = [
  ['a line break inside', 'abcdefgh\nijklmnopqrstuvwx'],
  ['a carriage return inside', 'abcdefgh\rijklmnopqrstuvwx'],
  ['two lines', `${HEX_TOKEN}\n${NAMED_TOKEN}\n`],
  ['two lines with \\r\\n', `${HEX_TOKEN}\r\n${NAMED_TOKEN}\r\n`],
  ['an empty line after the token', `${NAMED_TOKEN}\n\n`],
  ['a lone trailing \\r', `${NAMED_TOKEN}\r`],
  ['a leading space', ` ${NAMED_TOKEN}`],
  ['a trailing space', `${NAMED_TOKEN} `],
  ['a space after the line ending', `${NAMED_TOKEN}\n `],
  ['a space inside', 'api-token 0123456789abc'],
  ['a trailing tab', `${NAMED_TOKEN}\t`],
  ['a tab inside', 'api-token\t0123456789abc'],
  ['a NUL character', `${NAMED_TOKEN}\0`],
  ['a byte order mark', `﻿${NAMED_TOKEN}`],
  ['a character outside the set', `${NAMED_TOKEN}!`],
  ['a quote', `${NAMED_TOKEN}"`],
  ['a non-ASCII letter', `api-token-0123456789abé`],
  ['an emoji', `${NAMED_TOKEN}\u{1F511}`],
  ['a blank file', ''],
  ['only a line ending', '\n'],
  ['only spaces', '                '],
  ['15 characters', 'a'.repeat(15)],
  ['513 characters', 'a'.repeat(513)],
  ['513 characters and a line ending', `${'a'.repeat(513)}\n`],
  ['a file far larger than a token', 'a'.repeat(100_000)],
];

test('reads a token that is one line, with at most one trailing line ending, and says nothing', async () => {
  for (const [name, content, expected] of VALID) {
    const { token, lines } = await readAndLog(await tokenFile(content));
    assert.equal(token, expected, name);
    assert.deepEqual(lines, [], name);
  }
});

test('refuses anything else as not configured, saying which file and what is wrong and never a line of its content', async () => {
  for (const [name, content] of INVALID) {
    const file = await tokenFile(content);
    const { token, lines } = await readAndLog(file);
    assert.equal(token, null, name);
    assert.equal(lines.length, 1, `${name}: ${lines.join(' | ')}`);
    assert.ok(lines[0]?.startsWith('[Foreman next]') && lines[0].includes(file), `${name}: ${lines[0]}`);
    for (const line of content.split(/[\r\n]/).filter((part) => part.length >= 8)) assert.ok(!lines[0]?.includes(line), `${name}: the log holds the content`);
  }
});

test('says a problem once per file, again when it is another problem, and reads the file fresh each time', async () => {
  const file = await tokenFile(`${NAMED_TOKEN}\nsecond-line-0123456789\n`);
  assert.equal((await readAndLog(file)).lines.length, 1);
  assert.deepEqual(await readAndLog(file), { token: null, lines: [] });
  await writeFile(file, 'short');
  const another = await readAndLog(file);
  assert.equal(another.token, null);
  assert.equal(another.lines.length, 1);
  await writeFile(file, `${HEX_TOKEN}\n`);
  assert.deepEqual(await readAndLog(file), { token: HEX_TOKEN, lines: [] });
  await writeFile(file, NAMED_TOKEN);
  assert.deepEqual(await readAndLog(file), { token: NAMED_TOKEN, lines: [] });
});

test('refuses a token file that group or others can reach, with its path and mode and never its content, and reads one only its owner can', async () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o707]) {
    const file = await tokenFile(`${HEX_TOKEN}\n`, mode);
    const { token, lines } = await readAndLog(file);
    assert.equal(token, null, mode.toString(8));
    assert.equal(lines.length, 1, mode.toString(8));
    assert.ok(lines[0]?.startsWith('[Foreman next]') && lines[0].includes(file) && lines[0].includes(mode.toString(8)), lines[0]);
    assert.ok(!lines[0]?.includes(HEX_TOKEN));
  }
  for (const mode of [0o600, 0o400, 0o700]) {
    const { token, lines } = await readAndLog(await tokenFile(`${HEX_TOKEN}\n`, mode));
    assert.equal(token, HEX_TOKEN, mode.toString(8));
    assert.deepEqual(lines, [], mode.toString(8));
  }
});

test('the same file is refused while it is 0644 or 0640 and read once it is 0600, with no restart', async () => {
  const file = await tokenFile(`${HEX_TOKEN}\n`, 0o644);
  assert.equal((await readAndLog(file)).token, null);
  await chmod(file, 0o640);
  assert.equal((await readAndLog(file)).token, null);
  await chmod(file, 0o600);
  assert.deepEqual(await readAndLog(file), { token: HEX_TOKEN, lines: [] });
});

test('a missing file is just no token, with no log; a directory is refused as not a regular file', async () => {
  const directory = await freshDirectory();
  assert.deepEqual(await readAndLog(path.join(directory, 'missing')), { token: null, lines: [] });
  const file = await tokenFile(HEX_TOKEN);
  assert.deepEqual(await readAndLog(path.join(file, 'below-a-file')), { token: null, lines: [] });
  const folder = path.join(directory, 'a-folder');
  await mkdir(folder, { mode: 0o700 });
  const { token, lines } = await readAndLog(folder);
  assert.equal(token, null);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes('not a regular file') && lines[0].includes(folder), lines[0]);
});

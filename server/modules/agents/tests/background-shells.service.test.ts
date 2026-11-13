import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exitCodeOf,
  isTaskOutputPath,
  listBackgroundShells,
  parseBackgroundShells,
  resolveShellStatus,
  splitOutputEnd,
  tailLines,
  type OutputState,
  type ShellLiveState,
  type ShellRecord,
} from '@/modules/agents/background-shells.service.js';

// Transcript lines shaped like the ones Claude Code writes (compact JSON).
const line = (entry: unknown) => JSON.stringify(entry);

const toolUse = (id: string, name: string, input: Record<string, unknown>, timestamp: string) =>
  line({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } });

const toolResult = (toolUseId: string, text: string, toolUseResult: Record<string, unknown>, timestamp: string) =>
  line({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, is_error: false }] },
    toolUseResult,
  });

const notification = (taskIds: string[], status: string | null, summary: string, extra = '') =>
  '<task-notification>\n' +
  taskIds.map((id) => `<task-id>${id}</task-id>\n`).join('') +
  (status ? `<status>${status}</status>\n` : '') +
  `<summary>${summary}</summary>\n${extra}</task-notification>`;

const delivered = (text: string, timestamp: string) =>
  line({ type: 'user', timestamp, message: { role: 'user', content: text }, origin: { kind: 'task-notification' } });

const queued = (text: string, timestamp: string) =>
  line({ type: 'queue-operation', operation: 'enqueue', timestamp, content: text });

const backgroundStarted = (taskId: string, outputPath: string) =>
  `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}. ` +
  'You will be notified when it completes. To check interim output, use Read on that file path.';

const NO_LIVE: ShellLiveState = { liveTaskIds: null, tracked: new Map() };

// Output file state: last write time, optionally closed by the CLI.
const written = (mtimeMs: number | null, end: OutputState['end'] = null): OutputState => ({ mtimeMs, end });

function record(overrides: Partial<ShellRecord> = {}): ShellRecord {
  return {
    taskId: 'bshell001',
    toolUseId: 'toolu_1',
    kind: 'shell',
    description: 'Run tests',
    command: 'pnpm test',
    movedToBackground: false,
    startedAt: '2026-11-12T09:00:00.000Z',
    outputPath: null,
    ended: null,
    ...overrides,
  };
}

test('a background Bash command is read with how it ended, from the first (queued) report', () => {
  const output = '/tmp/claude-1000/-proj/sess/tasks/bc02ck9lv.output';
  const report = notification(['bc02ck9lv'], 'completed', 'Background command "Run baseline verify" completed (exit code 0)');
  const records = parseBackgroundShells([
    toolUse('toolu_1', 'Bash', { command: 'pnpm verify', description: 'Run baseline verify', run_in_background: true }, '2026-11-12T09:07:31.000Z'),
    toolResult('toolu_1', backgroundStarted('bc02ck9lv', output), { stdout: '', backgroundTaskId: 'bc02ck9lv' }, '2026-11-12T09:07:32.000Z'),
    queued(report, '2026-11-12T09:07:34.000Z'),
    delivered(report, '2026-11-12T09:07:40.000Z'),
  ]);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    taskId: 'bc02ck9lv',
    toolUseId: 'toolu_1',
    kind: 'shell',
    description: 'Run baseline verify',
    command: 'pnpm verify',
    movedToBackground: false,
    startedAt: '2026-11-12T09:07:32.000Z',
    outputPath: output,
    ended: {
      status: 'completed',
      summary: 'Background command "Run baseline verify" completed (exit code 0)',
      at: '2026-11-12T09:07:34.000Z',
    },
  });
});

test('a foreground command moved to the background after its timeout is listed too', () => {
  const [moved] = parseBackgroundShells([
    toolUse('toolu_2', 'Bash', { command: 'npx vitest run', description: 'Run the unit tests' }, '2026-11-12T09:00:00.000Z'),
    toolResult(
      'toolu_2',
      'Command did not complete within its 120s timeout and was moved to the background (ID: b7bdg5f2y). ' +
        'Output is being written to: /tmp/claude-1000/-proj/sess/tasks/b7bdg5f2y.output. You will be notified when it completes.',
      { stdout: '', backgroundTaskId: 'b7bdg5f2y', timedOutAfterMs: 120000 },
      '2026-11-12T09:02:00.000Z',
    ),
  ]);
  assert.equal(moved.taskId, 'b7bdg5f2y');
  assert.equal(moved.movedToBackground, true);
  assert.equal(moved.outputPath, '/tmp/claude-1000/-proj/sess/tasks/b7bdg5f2y.output');
  assert.equal(moved.ended, null);
});

test('a Monitor is a background task; its events do not end it, its stream ending does', () => {
  const lines = [
    toolUse('toolu_3', 'Monitor', { command: 'tail -f build.log', description: 'build progress' }, '2026-11-12T10:00:00.000Z'),
    toolResult(
      'toolu_3',
      'Monitor started (task bdnn2z913, expires in 30m unless the source ends first). You will be notified on each event.',
      { taskId: 'bdnn2z913', timeoutMs: 1800000, persistent: false },
      '2026-11-12T10:00:01.000Z',
    ),
    delivered(notification(['bdnn2z913'], null, 'Monitor event: "build progress"', '<event>step 3/9</event>\n'), '2026-11-12T10:01:00.000Z'),
  ];
  const [watching] = parseBackgroundShells(lines);
  assert.equal(watching.kind, 'monitor');
  assert.equal(watching.description, 'build progress');
  assert.equal(watching.outputPath, null);
  assert.equal(watching.ended, null);

  const [ended] = parseBackgroundShells([
    ...lines,
    delivered(notification(['bdnn2z913'], 'completed', 'Monitor "build progress" stream ended'), '2026-11-12T10:05:00.000Z'),
  ]);
  assert.equal(ended.ended?.status, 'completed');
});

test('one report stopping several orphaned shells ends each of them, skipping scan markers', () => {
  const started = ['bvu7p76gv', 'b3xiwmsrr'].flatMap((id, index) => [
    toolUse(`toolu_${id}`, 'Bash', { command: `job ${index}`, run_in_background: true }, '2026-11-12T08:00:00.000Z'),
    toolResult(`toolu_${id}`, backgroundStarted(id, `/tmp/claude-1000/-p/s/tasks/${id}.output`), { backgroundTaskId: id }, '2026-11-12T08:00:01.000Z'),
  ]);
  const records = parseBackgroundShells([
    ...started,
    delivered(
      notification(
        ['bvu7p76gv', 'b3xiwmsrr', '__orphan_summary__:shell'],
        'stopped',
        "2 background shell command tasks didn't finish before the previous session ended. Task ids: bvu7p76gv, b3xiwmsrr.",
      ),
      '2026-11-12T11:00:00.000Z',
    ),
  ]);
  assert.deepEqual(records.map((entry) => [entry.taskId, entry.ended?.status]), [
    ['bvu7p76gv', 'stopped'],
    ['b3xiwmsrr', 'stopped'],
  ]);
});

test('a shell whose tool call fell outside the scanned tail takes its description from the report', () => {
  const [shell] = parseBackgroundShells([
    toolResult('toolu_old', backgroundStarted('bold00001', '/tmp/claude-1000/-p/s/tasks/bold00001.output'), { backgroundTaskId: 'bold00001' }, '2026-11-12T09:00:00.000Z'),
    delivered(notification(['bold00001'], 'failed', 'Background command "Seed the database" failed with exit code 3'), '2026-11-12T09:00:05.000Z'),
  ]);
  assert.equal(shell.description, 'Seed the database');
  assert.equal(shell.command, '');
  assert.equal(shell.ended?.status, 'failed');
});

test('foreground commands, subagent reports and torn lines are not background shells', () => {
  const records = parseBackgroundShells([
    toolUse('toolu_fg', 'Bash', { command: 'ls' }, '2026-11-12T09:00:00.000Z'),
    toolResult('toolu_fg', 'file.txt', { stdout: 'file.txt', stderr: '' }, '2026-11-12T09:00:01.000Z'),
    delivered(notification(['a9034e0acbb57904d'], 'completed', 'Agent "Review" finished'), '2026-11-12T09:00:02.000Z'),
    '{"type":"user","message":{"content":"<task-notification>',
  ]);
  assert.deepEqual(records, []);
});

test('the reported status wins; an orphan report ends at the last output write', () => {
  const lastWrite = Date.parse('2026-11-12T09:30:00.000Z');
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  const ended = (status: string, summary: string) => record({ ended: { status, summary, at: '2026-11-12T09:10:00.000Z' } });

  assert.deepEqual(resolveShellStatus(ended('completed', 'completed (exit code 0)'), NO_LIVE, written(lastWrite), now), {
    status: 'done',
    endedAt: '2026-11-12T09:10:00.000Z',
  });
  assert.equal(resolveShellStatus(ended('failed', 'failed with exit code 2'), NO_LIVE, written(lastWrite), now).status, 'failed');
  assert.equal(resolveShellStatus(ended('killed', 'was stopped after reaching its background time limit'), NO_LIVE, written(null), now).status, 'stopped');
  assert.deepEqual(
    resolveShellStatus(ended('stopped', "Background shell command didn't finish before the previous session ended"), NO_LIVE, written(lastWrite), now),
    { status: 'stopped', endedAt: '2026-11-12T09:30:00.000Z' },
  );
  // Even while the live process still lists it, a written report is final.
  const live: ShellLiveState = { liveTaskIds: new Set(['bshell001']), tracked: new Map() };
  assert.equal(resolveShellStatus(ended('completed', 'completed (exit code 0)'), live, written(lastWrite), now).status, 'done');
});

test('without a report, the live process decides, then the runtime events, then the output file', () => {
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  const shell = record();
  const stale = now - 10 * 60_000;

  assert.equal(resolveShellStatus(shell, { liveTaskIds: new Set(['bshell001']), tracked: new Map() }, written(stale), now).status, 'running');
  assert.equal(resolveShellStatus(shell, { liveTaskIds: new Set(), tracked: new Map([['bshell001', 'running']]) }, written(stale), now).status, 'running');
  assert.equal(resolveShellStatus(shell, { liveTaskIds: null, tracked: new Map([['bshell001', 'finished']]) }, written(stale), now).status, 'done');
  assert.equal(resolveShellStatus(shell, { liveTaskIds: null, tracked: new Map([['bshell001', 'failed']]) }, written(stale), now).status, 'failed');
  // A process that died mid-run leaves its last event at running; that alone proves nothing.
  assert.equal(resolveShellStatus(shell, { liveTaskIds: null, tracked: new Map([['bshell001', 'running']]) }, written(stale), now).status, 'stopped');
  // Started by an earlier process of a session that is live again.
  assert.equal(resolveShellStatus(shell, { liveTaskIds: new Set(), tracked: new Map() }, written(stale), now).status, 'stopped');
  // Run elsewhere (e.g. a terminal CLI): output still being written.
  assert.equal(resolveShellStatus(shell, NO_LIVE, written(now - 5_000), now).status, 'running');
  assert.deepEqual(resolveShellStatus(shell, NO_LIVE, written(stale), now), { status: 'stopped', endedAt: new Date(stale).toISOString() });
  assert.deepEqual(resolveShellStatus(shell, NO_LIVE, written(null), now), { status: 'stopped', endedAt: null });
});

test('how the CLI closed the output file settles a shell that left no report', () => {
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  const closedAt = now - 60_000;
  const shell = record();
  // Stopped from the UI or torn down with its session: only the file says so.
  assert.deepEqual(resolveShellStatus(shell, NO_LIVE, written(closedAt, { killed: true, exitCode: null }), now), {
    status: 'stopped',
    endedAt: new Date(closedAt).toISOString(),
  });
  assert.equal(resolveShellStatus(shell, NO_LIVE, written(closedAt, { killed: false, exitCode: 0 }), now).status, 'done');
  assert.equal(resolveShellStatus(shell, NO_LIVE, written(closedAt, { killed: false, exitCode: 3 }), now).status, 'failed');
  // The live process still listing it outranks a closing-looking line it printed itself.
  const live: ShellLiveState = { liveTaskIds: new Set(['bshell001']), tracked: new Map() };
  assert.equal(resolveShellStatus(shell, live, written(closedAt, { killed: true, exitCode: null }), now).status, 'running');
});

test('the closing line is split off the output tail', () => {
  assert.deepEqual(splitOutputEnd(['built', '[exited with code 0]']), { lines: ['built'], end: { killed: false, exitCode: 0 } });
  assert.deepEqual(splitOutputEnd(['[exited with code 3]']), { lines: [], end: { killed: false, exitCode: 3 } });
  assert.deepEqual(splitOutputEnd(['tick 4', '[killed]']), { lines: ['tick 4'], end: { killed: true, exitCode: null } });
  assert.deepEqual(splitOutputEnd(['tick 4']), { lines: ['tick 4'], end: null });
  assert.deepEqual(splitOutputEnd([]), { lines: [], end: null });
});

test('exit codes are read from the end of the report', () => {
  assert.equal(exitCodeOf('Background command "Run tests" completed (exit code 0)'), 0);
  assert.equal(exitCodeOf('Background command "sleep 3; exit 3" failed with exit code 3'), 3);
  assert.equal(exitCodeOf('Background command "exit 5 probe" completed (exit code 0)'), 0);
  assert.equal(exitCodeOf('Monitor "watch" script failed (exit 1)'), 1);
  assert.equal(exitCodeOf("Background shell command didn't finish before the previous session ended"), null);
  assert.equal(exitCodeOf(null), null);
});

test('output tails show what a terminal would: last non-empty lines, no escapes, final progress state', () => {
  const text = 'first\n\n\x1B[32mgreen\x1B[0m\nprogress 10%\rprogress 50%\rprogress 100%\n  indented  \nlast\n\n';
  assert.deepEqual(tailLines(text, 5), ['first', 'green', 'progress 100%', '  indented', 'last']);
  assert.deepEqual(tailLines(text, 2), ['  indented', 'last']);
  // A tail read from the middle of a file drops its torn first line.
  assert.deepEqual(tailLines('rn line\nwhole\n', 5, true), ['whole']);
  assert.equal(tailLines('x'.repeat(500))[0].length, 241);
  assert.deepEqual(tailLines(''), []);
});

test('only task output files inside Claude Code task directories may be read', () => {
  const roots = ['/tmp/claude-1000'];
  assert.equal(isTaskOutputPath('/tmp/claude-1000/-proj/sess/tasks/b1.output', 'b1', roots), true);
  assert.equal(isTaskOutputPath('/tmp/claude-1000/-proj/sess/tasks/b2.output', 'b1', roots), false);
  assert.equal(isTaskOutputPath('/tmp/claude-1000/-proj/sess/other/b1.output', 'b1', roots), false);
  assert.equal(isTaskOutputPath('/tmp/claude-10001/-proj/sess/tasks/b1.output', 'b1', roots), false);
  assert.equal(isTaskOutputPath('/etc/tasks/b1.output', 'b1', roots), false);
  assert.equal(isTaskOutputPath('/tmp/claude-1000/x/tasks/...output', '..', roots), false);
});

test('listing reads tails safely, keeps the current stretch, and puts running shells first', async () => {
  const previousTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'bg-shells-root-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'bg-shells-elsewhere-'));
  process.env.CLAUDE_CODE_TMPDIR = root;
  try {
    const tasks = path.join(root, '-proj', 'sess', 'tasks');
    await mkdir(tasks, { recursive: true });
    const jsonlPath = path.join(elsewhere, '-proj', 'sess.jsonl');
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

    await writeFile(path.join(tasks, 'brunning1.output'), 'tick 1\ntick 2\ntick 3\n');
    await writeFile(path.join(tasks, 'bdone0001.output'), 'built\n[exited with code 0]\n');
    // Stopped from the UI: no report in the transcript, only the file's closing line.
    await writeFile(path.join(tasks, 'bkilled01.output'), 'tick 1\n[killed]\n');
    await utimes(path.join(tasks, 'bkilled01.output'), new Date(now - 25 * 60_000), new Date(now - 25 * 60_000));
    // A monitor's file is found beside the shells' even though its path is never printed.
    await writeFile(path.join(tasks, 'bmonitor1.output'), 'event a\n');
    // Planted outside the task directories, and a symlink pointing out of them.
    const secret = path.join(elsewhere, 'bescape01.output');
    await writeFile(secret, 'secret\n');
    await symlink(secret, path.join(tasks, 'bsymlink1.output'));
    await utimes(path.join(tasks, 'bdone0001.output'), new Date(now - 50 * 60_000), new Date(now - 50 * 60_000));

    const start = (id: string, minutesAgo: number, outputPath: string, description: string) => [
      toolUse(`toolu_${id}`, 'Bash', { command: `run ${id}`, description, run_in_background: true }, at(minutesAgo)),
      toolResult(`toolu_${id}`, backgroundStarted(id, outputPath), { backgroundTaskId: id }, at(minutesAgo)),
    ];
    const lines = [
      ...start('bold00001', 300, path.join(tasks, 'bold00001.output'), 'Before the pause'),
      delivered(notification(['bold00001'], 'completed', 'Background command "Before the pause" completed (exit code 0)'), at(299)),
      ...start('bdone0001', 60, path.join(tasks, 'bdone0001.output'), 'Build'),
      delivered(notification(['bdone0001'], 'completed', 'Background command "Build" completed (exit code 0)'), at(50)),
      ...start('bescape01', 40, secret, 'Escapes'),
      ...start('bsymlink1', 30, path.join(tasks, 'bsymlink1.output'), 'Symlinked'),
      ...start('bkilled01', 28, path.join(tasks, 'bkilled01.output'), 'Killed'),
      ...start('brunning1', 20, path.join(tasks, 'brunning1.output'), 'Ticks'),
      toolUse('toolu_mon', 'Monitor', { command: 'tail -f x', description: 'Watch' }, at(10)),
      toolResult('toolu_mon', 'Monitor started (task bmonitor1, expires in 30m).', { taskId: 'bmonitor1' }, at(10)),
    ];

    const shells = await listBackgroundShells({
      jsonlPath,
      lines,
      stretchStart: now - 120 * 60_000,
      live: { liveTaskIds: new Set(['brunning1', 'bmonitor1']), tracked: new Map() },
      now,
    });

    assert.deepEqual(
      shells.map((shell) => [shell.taskId, shell.status]),
      [
        ['bmonitor1', 'running'],
        ['brunning1', 'running'],
        ['bkilled01', 'stopped'],
        ['bsymlink1', 'stopped'],
        ['bescape01', 'stopped'],
        ['bdone0001', 'done'],
      ],
    );
    const byId = new Map(shells.map((shell) => [shell.taskId, shell]));
    assert.deepEqual(byId.get('brunning1')?.outputTail, ['tick 1', 'tick 2', 'tick 3']);
    assert.equal(byId.get('brunning1')?.durationMs, 20 * 60_000);
    assert.deepEqual(byId.get('bmonitor1')?.outputTail, ['event a']);
    assert.equal(byId.get('bmonitor1')?.kind, 'monitor');
    assert.deepEqual(byId.get('bescape01')?.outputTail, []);
    assert.deepEqual(byId.get('bsymlink1')?.outputTail, []);
    assert.equal(byId.get('bdone0001')?.exitCode, 0);
    assert.deepEqual(byId.get('bdone0001')?.outputTail, ['built']);
    assert.deepEqual(byId.get('bkilled01')?.outputTail, ['tick 1']);
    assert.equal(byId.get('bkilled01')?.durationMs, 3 * 60_000);
    assert.equal(byId.get('bdone0001')?.durationMs, 10 * 60_000);
  } finally {
    if (previousTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previousTmpdir;
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

/**
 * Abort must escalate to signals only when the cooperative interrupt actually
 * failed. Regression cover for the fork-local escalation that keyed off "is the
 * child still alive", which is true after a *successful* interrupt too and so
 * SIGTERMed the provider process on every Stop press.
 *
 * These tests spawn a real child of the test process carrying a fake session id
 * in its argv, so findSessionPids/killPids run for real rather than as mocks.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

// Shrink the production waits so the escalation path is quick to exercise.
process.env.CLAUDE_ABORT_INTERRUPT_TIMEOUT_MS = '300';
process.env.CLAUDE_ABORT_SIGKILL_GRACE_MS = '300';

const { abortClaudeSDKSession, isClaudeSDKSessionActive, __testing__ } = await import(
  './claude-sdk.js'
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Spawns a long-lived child whose argv contains `sessionId`, so pgrep -f finds it. */
async function spawnDecoy(sessionId: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', sessionId], {
    stdio: 'ignore',
  });
  // Give pgrep a moment to see it in the process table.
  await sleep(300);
  return child;
}

/** A query-instance stand-in whose interrupt() behaves as the test requires. */
function fakeInstance(interrupt: () => Promise<void>) {
  return { interrupt, calls: 0 };
}

test('a successful interrupt does NOT signal the child process', async () => {
  const sessionId = 'aaaaaaaa1111successaaaaaaaa';
  const decoy = await spawnDecoy(sessionId);
  const pid = decoy.pid!;

  try {
    assert.equal(isAlive(pid), true, 'decoy should be running before abort');
    assert.deepEqual(
      __testing__.findSessionPids(sessionId),
      [pid],
      'findSessionPids must locate the decoy by its argv'
    );

    let interruptCalls = 0;
    __testing__.addSession(
      sessionId,
      fakeInstance(async () => {
        interruptCalls += 1;
      })
    );

    const result = await abortClaudeSDKSession(sessionId);

    assert.equal(result, true, 'abort should report success');
    assert.equal(interruptCalls, 1, 'interrupt() should have been called exactly once');
    assert.equal(
      isAlive(pid),
      true,
      'REGRESSION: a clean interrupt must leave the child process alone'
    );
    // Falsy, not strictly false: isClaudeSDKSessionActive returns undefined for
    // an unknown session id.
    assert.ok(!isClaudeSDKSessionActive(sessionId), 'session should be deregistered');
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('an interrupt that throws DOES escalate to signals', async () => {
  const sessionId = 'bbbbbbbb2222throwsbbbbbbbb';
  const decoy = await spawnDecoy(sessionId);
  const pid = decoy.pid!;

  try {
    __testing__.addSession(
      sessionId,
      fakeInstance(async () => {
        throw new Error('stop_reason=tool_use');
      })
    );

    await abortClaudeSDKSession(sessionId);
    await sleep(300);

    assert.equal(isAlive(pid), false, 'a failed interrupt must escalate and kill the child');
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('an interrupt that hangs past the timeout DOES escalate to signals', async () => {
  const sessionId = 'cccccccc3333hangscccccccc';
  const decoy = await spawnDecoy(sessionId);
  const pid = decoy.pid!;

  try {
    __testing__.addSession(
      sessionId,
      // Never settles: the timeout arm has to be what decides the outcome.
      fakeInstance(() => new Promise<void>(() => {}))
    );

    await abortClaudeSDKSession(sessionId);
    await sleep(300);

    assert.equal(isAlive(pid), false, 'a timed-out interrupt must escalate and kill the child');
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('concurrent aborts for one session share a single in-flight abort', async () => {
  const sessionId = 'dddddddd4444concurrentdddd';
  let interruptCalls = 0;

  __testing__.addSession(
    sessionId,
    fakeInstance(async () => {
      interruptCalls += 1;
      await sleep(200);
    })
  );

  const [first, second, third] = await Promise.all([
    abortClaudeSDKSession(sessionId),
    abortClaudeSDKSession(sessionId),
    abortClaudeSDKSession(sessionId),
  ]);

  assert.equal(interruptCalls, 1, 'REGRESSION: a second Stop press must not start a second abort');
  assert.deepEqual([first, second, third], [true, true, true], 'all callers get the same result');
});

/** Captures [LIFECYCLE] lines emitted while `run` executes. */
function captureTrace(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[LIFECYCLE]')) {
      lines.push(line);
    }
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

const toolUse = (id: string, background: boolean) => ({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Agent',
        input: { run_in_background: background, description: 'probe', subagent_type: 'general-purpose' },
      },
    ],
  },
});

const toolResult = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id }] },
});

test('a subagent left open at turn end is traced as orphaned, with its background flag', () => {
  const lines = captureTrace(() => {
    const tracker = __testing__.createSubagentTracker(42);
    tracker.observe(toolUse('bg_1', true));
    tracker.observe(toolUse('fg_1', false));
    tracker.observe(toolResult('fg_1')); // foreground one completes in-turn
    const orphaned = tracker.reportOrphans(42, 'generator_end');
    assert.equal(orphaned, 1, 'only the background subagent should still be open');
    assert.equal(tracker.finishedCount, 1);
  });

  const orphan = lines.find((line) => line.includes('subagent.orphaned'));
  assert.ok(orphan, 'an orphaned subagent must be traced');
  assert.match(orphan!, /toolUseId=bg_1/);
  assert.match(orphan!, /background=true/);
  assert.match(orphan!, /turnEndReason=generator_end/);
  assert.match(orphan!, /why=background-subagent-cannot-outlive-its-turn/);

  assert.ok(
    !lines.some((line) => line.includes('subagent.orphaned') && line.includes('fg_1')),
    'a subagent that returned its tool_result must not be reported as orphaned'
  );
});

test('subagent start and finish are both traced', () => {
  const lines = captureTrace(() => {
    const tracker = __testing__.createSubagentTracker(7);
    tracker.observe(toolUse('a_1', false));
    tracker.observe(toolResult('a_1'));
  });

  assert.ok(lines.some((l) => l.includes('subagent.started') && l.includes('toolUseId=a_1')));
  assert.ok(lines.some((l) => l.includes('subagent.finished') && l.includes('toolUseId=a_1')));
});

test('findSessionPids does not fall back to matching every claude child', async () => {
  // The old implementation fell back to `pgrep -f claude` when the id missed,
  // which matched every concurrent session's child (the SDK's own binary path
  // contains "claude"). An unmatched id must resolve to nothing at all.
  const decoy = await spawnDecoy('eeeeeeee5555presenteeeeeeee');
  try {
    assert.deepEqual(
      __testing__.findSessionPids('ffffffff6666absentffffffff'),
      [],
      'an unmatched session id must not resolve to unrelated processes'
    );
    // Shell metacharacters must not be executed, and must not match anything.
    assert.deepEqual(__testing__.findSessionPids('$(touch /tmp/pwned)'), []);
    assert.deepEqual(__testing__.findSessionPids('-f'), []);
  } finally {
    decoy.kill('SIGKILL');
  }
});

# Abort escalated to SIGTERM/SIGKILL on every Stop, killing the turn's process

**Component:** `server/claude-sdk.js` — `abortClaudeSDKSession`, `findSessionPids`
**Reported:** 2026-08-08
**Fixed:** 2026-08-08
**Severity:** high — every Stop press signalled the provider process instead of interrupting the query
**Status:** fixed, with regression cover in `server/claude-sdk.abort.test.ts`
**Related:** lifecycle tracing added for the still-open subagent question — see
[Lifecycle tracing](#lifecycle-tracing)

> This document was rewritten after a second investigation. The first version reached the right
> headline (the escalation fired when it shouldn't) from the wrong mechanism, and its evidence did not
> support its conclusion. The superseded claims are kept in
> [Refuted hypotheses](#refuted-hypotheses--recorded-so-they-are-not-re-investigated) so nobody
> re-derives them.

## Summary

Pressing Stop sends `chat.abort`, which reaches `abortClaudeSDKSession`. That function performed a
cooperative `interrupt()`, waited one second, and then checked whether the `claude` child process was
still alive. If it was, the code concluded the interrupt had failed and escalated to `SIGTERM`, then
`SIGKILL`.

Two independent defects made that escalation unconditional in practice:

1. **The liveness check was not a failure signal.** A child is *expected* to still be running one
   second after a successful interrupt — the turn takes time to unwind, and the SDK tears the child
   down itself when it finishes. Measured teardown was longer than the 1s the code waited (see
   [Process lifecycle](#process-lifecycle-measured)), so `alive.length > 0` was a race the code
   reliably lost.
2. **`Promise.race` against a bare `setTimeout` could not report a timeout.** The timer arm resolved
   normally, so a 5s hang was indistinguishable from a fast success — and the `catch` logged
   `interrupt() threw` and then discarded it, so the one genuine failure signal never influenced the
   decision either.

Net effect: a cooperative interrupt was implemented as a process kill.

## Process lifecycle (measured)

This matters because it is the reason the liveness check cannot work, and because it bounds what
aborting can even damage.

The child is **per turn, not per session**. `queryClaudeSDK` calls `query()` once per user message
with `sdkOptions.resume = sessionId` (`server/claude-sdk.js:230-232`, `:612`), and the SDK tears the
child down when that turn's generator finishes. Probed directly against the installed SDK with a
string prompt (the default path — `buildPromptPayload` only returns a generator when images are
attached):

| scenario | child state after the generator loop exits |
|---|---|
| loop runs to natural end | already dead at +0ms |
| loop `break`s on the `result` message | **alive** at +500ms, dead by ~+2.5s |

So the child outlives a completed turn by up to a couple of seconds — comfortably longer than the
code's 1s window.

*Caveat on the numbers:* the probe ran against the SDK's bundled binary
(`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`), which had no credentials in that
context, so the turn ended early with `Not logged in`. A real turn interrupted mid `tool_use` unwinds
*slower* than this, not faster, so the conclusion holds with margin.

## Evidence

Journal (`journalctl --user`, server PID 6062), unfiltered across the window:

```
14:49:11  Starting async generator loop for session: b7b20c2b-...
14:49:22  im-config[386062]: IM_CONFIG_ENTRY='profile' ... PID=385980 PPID=384800
14:49:40  [ABORT] Aborting SDK session: b7b20c2b-...
14:49:45  [ABORT] Aborting SDK session: b7b20c2b-...
14:49:46  [ABORT] Session b7b20c2b-... still alive (PIDs: 384800), sending SIGTERM
14:49:46  [ABORT] Sent SIGTERM to PID 384800
14:49:47  SDK query error: Error: Claude Code returned an error result:
            [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use
              at Ah.readMessages (.../claude-agent-sdk/sdk.mjs:60:19526)
14:49:47  [ABORT] interrupt() threw for b7b20c2b-...: Claude Code returned an error result: ...
14:50:10  Starting async generator loop for session: b7b20c2b-...
```

Three things to read off this:

- **Stop was pressed twice** (14:49:40 and 14:49:45). See
  [Concurrent aborts](#secondary-defect-concurrent-aborts-were-not-guarded).
- **The trigger was the timeout, not a thrown interrupt.** Abort #1's 5s timer expired at 14:49:45,
  releasing it into the liveness check; SIGTERM followed at 14:49:46. The throw is logged at
  14:49:47 — *one second after* the kill.
- **The turn was mid tool call.** `im-config` firing with `PPID=384800` is a login shell sourcing
  `profile.d`, i.e. a Bash tool call in flight under the child. That independently corroborates
  `stop_reason=tool_use`, which is the condition the SDK cannot always interrupt cleanly.

`[ede_diagnostic] ...` is not an SDK string — it does not appear anywhere in the installed package.
The SDK formats `Claude Code returned an error result: ${this.lastErrorResultText}`, so that text is
the `claude` CLI's own diagnostic relayed through the result message.

Whether the throw was *caused* by the SIGTERM or was an independent mid-`tool_use` failure cannot be
settled from these logs. It does not matter for the fix: the escalation was already committed by the
timeout before either could be known.

## The code, as it was

`server/claude-sdk.js` (≈ line 775, before the fix):

```js
// Step 1: cooperative interrupt via SDK (5s timeout)
try {
  await Promise.race([
    session.instance.interrupt(),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
} catch (e) {
  console.warn(`[ABORT] interrupt() threw for ${sessionId}:`, e?.message);
}

// Step 2: check if child process is still alive
await new Promise(resolve => setTimeout(resolve, 1000));
let pids = findSessionPids(sessionId);
const alive = pids.filter(isProcessAlive);

if (alive.length > 0) {
  console.warn(`[ABORT] Session ${sessionId} still alive (PIDs: ${alive}), sending SIGTERM`);
  killPids(alive, 'SIGTERM');
  // ... 3s later, SIGKILL to survivors
}
```

This was **not upstream behaviour**. It arrived with the fork customizations in `b00e94b`; upstream
v1.36.3 (`27eaf01`) is a bare `await session.instance.interrupt()` with no PID logic at all.

## Secondary defect: concurrent aborts were not guarded

`handleChatAbort` guards on `run.status !== 'running'`, but `chatRunRegistry.completeRun` only runs
*after* `await abortFn(...)` returns (`chat-websocket.service.ts:255-261`) — and the abort took ~6s
(5s race + 1s + 3s). A second Stop press inside that window therefore passed the guard, and
`abortClaudeSDKSession` had no re-entrancy guard of its own (`removeSession` was its last statement),
so two full escalation ladders ran concurrently against one query instance.

## Secondary defect: the `findSessionPids` fallback could signal unrelated sessions

```js
const output = execSync(
  `pgrep -P ${process.pid} -f "${sessionId}" 2>/dev/null || pgrep -P ${process.pid} -f "claude" 2>/dev/null || true`,
  { encoding: 'utf-8', timeout: 5000 }
);
```

When the first `pgrep` found nothing it exited non-zero and the `||` fallback matched **every**
`claude` child of the server — and it matched them reliably, because the SDK's own binary path
contains `claude`. With more than one concurrent session, aborting session A would signal session B.

The fallback was worst precisely where it was least able to identify its target: a brand-new session
has no provider id in argv yet (no `--resume`), and `handleChatAbort` falls back to the app id in
exactly that window (`abortSessionId = run.providerSessionId || sessionId`). So the case that missed
the specific match was the case that shotgunned every child.

Interpolating `sessionId` into a shell string was also a latent injection shape. Reachable ids are
UUID-formed today (`sessions.service.ts:132` uses `randomUUID()`; provider ids come from the CLI), so
it was not exploitable, but the field originates in a client message and should never have reached a
shell.

## The fix

`server/claude-sdk.js`, +122/−32:

1. **The race reports its outcome.** `interrupt().then(() => 'ok')` against
   `sleep(INTERRUPT_TIMEOUT_MS).then(() => 'timeout')`, with the `catch` setting `'error'`. The
   outcome, not process liveness, decides what happens next.
2. **Escalation only on `timeout` or `error`.** On `'ok'` the child is left alone — the SDK is
   unwinding the turn and disposes of it. The 1s-sleep-and-check step is gone; it tested a condition
   that is true on success.
3. **Escalation is kept, deliberately.** A turn stopped mid `tool_use` is the case the original
   customization existed to handle: `interrupt()` cannot complete, and Stop still has to stop. That
   path now runs with an actual failure in hand.
4. **No `pgrep -f "claude"` fallback.** If the id cannot be matched, nothing is signalled and the miss
   is logged. Killing an unidentified process is worse than not killing.
5. **`execFileSync` with an argument array**, plus an id-shape guard — which also prevents a leading
   `-` from being parsed as a pgrep flag. No shell sees the id.
6. **Re-entrancy guard.** `inFlightAborts` maps a session id to its pending abort; a second call joins
   the first rather than starting a second ladder.
7. **Session-map leak closed.** A run registers under both the app id and the provider id, so
   `removeSessionsForInstance` drops every key pointing at the instance instead of only the one abort
   was called with (which used to leave `isClaudeSDKSessionActive` true for a dead run).
8. **Error path follows upstream again** — un-mark the session and leave it registered so the run can
   emit its own terminal complete, instead of removing it.

`INTERRUPT_TIMEOUT_MS` and `SIGKILL_GRACE_MS` are overridable via
`CLAUDE_ABORT_INTERRUPT_TIMEOUT_MS` / `CLAUDE_ABORT_SIGKILL_GRACE_MS`, following the existing
`TOOL_APPROVAL_TIMEOUT_MS` pattern, so tests need not wait 8 seconds.

## Verification

`server/claude-sdk.abort.test.ts` (`node:test`). Each test spawns a real child of the test process
carrying a fake session id in its argv, so `findSessionPids` and `killPids` run for real rather than
as mocks:

| test | asserts |
|---|---|
| clean interrupt | **child still alive** — the regression itself |
| interrupt throws | child is signalled and dies |
| interrupt hangs past timeout | child is signalled and dies |
| 3 concurrent aborts | `interrupt()` called exactly once |
| unmatched / hostile id | `[]` for a miss, for `$(touch /tmp/pwned)` and for `-f`; no file created |

Two further tests cover the tracing, by capturing `[LIFECYCLE]` lines while driving the tracker:

| test | asserts |
|---|---|
| subagent left open at turn end | traced as `subagent.orphaned` with `background=true`; a subagent that returned its `tool_result` is **not** reported |
| subagent start/finish | both `subagent.started` and `subagent.finished` are emitted |

All 7 pass. `tsc --noEmit -p server/tsconfig.json` clean; `eslint` clean.

Full server suite: **136 tests, 107 pass, 29 fail**. Those 29 were checked against a stashed
baseline — **129 / 100 / 29 with identical failure names** — so they are pre-existing and unrelated
(db, codex and opencode suites).

The test lives at the `server/` root beside `opencode-cli.test.js` rather than under
`server/modules/providers/tests/`: `server/claude-sdk.js` is not a declared `boundaries/elements`
entry, so importing it from inside a module element trips `boundaries/no-unknown`. Relocating the
test was preferable to widening the architecture config.

`dist-server/` was rebuilt (`npm run build:server`). **This step is required** — `npm run server`
runs `dist-server/server/index.js`, so a source-only fix has no effect on the running service.

## Lifecycle tracing

Added in the same change, but diagnostic rather than corrective: it fixes nothing. It exists because
the remaining subagent problem rests on an *inference* — the per-turn lifecycle is measured, but a
background subagent has never been observed dying in situ. These traces are what turn that inference
into an observation, from the journal alone.

All output is single-line `key=value` under one prefix:

```bash
journalctl --user -f | grep '\[LIFECYCLE\]'                # live
journalctl --user | grep '\[LIFECYCLE\]' | grep 'turn=7'   # one turn end to end
```

| event | carries |
|---|---|
| `turn.start`, `turn.query_created`, `turn.loop_start` | turn number, session, resume, model, permission mode |
| `turn.message` | `system` and `result` messages only — `subtype`, `stop_reason`, `is_error` |
| `subagent.started` | tool_use id, **`background`**, `subagent_type`, description |
| `subagent.finished` | matching `tool_result`, duration, `is_error` |
| **`subagent.orphaned`** | still open when the turn ended — the signal to grep for |
| `turn.end` | reason, duration, message counts, `subagentsFinished`, `subagentsOrphaned` |
| `child.spawned` | pid and argv of each provider child |
| **`child.exited`** | lifetime, `signalled`, **`attribution`** |
| `child.signalled` | signal plus the argv read *before* the kill |
| `abort.*` | `requested`, `joined_in_flight`, `interrupt_start`, `interrupt_outcome`, `escalating`, `no_escalation` |

### The chain that settles the question

If the diagnosis in this document is right, this appears with **no abort event anywhere in it**:

```
subagent.started  turn=7 toolUseId=toolu_01 background=true subagentType=general-purpose
turn.end          turn=7 reason=generator_end subagentsOrphaned=1
subagent.orphaned turn=7 toolUseId=toolu_01 background=true why=background-subagent-cannot-outlive-its-turn
child.exited      pid=384800 lifetimeMs=41230 signalled=none attribution=sdk-teardown-or-self-exit
```

`signalled=none` is the load-bearing field: it separates the architectural teardown from a kill by
the abort path. If `attribution=killed-by-server` shows up instead, the diagnosis here is wrong and
the abort path is still implicated.

Note the limit of the attribution: it distinguishes *server-signalled* from *not server-signalled*.
It cannot tell an SDK teardown from the child exiting of its own accord — which is why the two are
reported as one value. That distinction is not needed to answer the question.

### Design constraints

- **`turn.end` has a single exit point** (`endTurn`), called on both the normal and the throw path, so
  no code path can end a turn without a trace.
- **The child watcher only runs while a turn is open**, polls every 250ms, and `unref()`s its timer, so
  tracing never holds the event loop open. It lingers 5s past the last turn on purpose — the exit
  that follows `turn.end` is the one worth catching.
- **Only provider children are traced** (argv contains `claude`); the server's own short-lived helpers
  (`pgrep`, `git`, …) would otherwise drown the log.
- **Subagent output is counted, not traced per message** — `turn.end` carries
  `subagentMessages={"toolu_01":42}` instead of one line per message.
- **`killPids` reads argv before signalling.** A killed process becomes a zombie with an empty
  cmdline, and "what did we just kill" is the entire value of that line.
- Every trace call is failure-isolated; tracing must never break a run.

`CLAUDE_LIFECYCLE_LOG=off` disables it; `CLAUDE_LIFECYCLE_POLL_MS` tunes the poll interval.

## Refuted hypotheses — recorded so they are not re-investigated

> "`pgrep -f "${sessionId}"` never matches because the session id isn't in `claude`'s argv, so the
> `||` fallback always fires and shotguns every child."

**Refuted.** The id *is* in argv via `--resume` for a resumed session:

```
$ tr '\0' ' ' < /proc/390417/cmdline
... claude --resume b7b20c2b-95fa-4de9-a5d3-60557e8e706a ...
$ pgrep -P 6062 -f "b7b20c2b-95fa-4de9-a5d3-60557e8e706a"
390417
```

The fallback was still a real bug, but it fired only in the brand-new-session window, not always.

> "`interrupt()` does not and should not terminate the process, which stays up to serve the next
> message in the session." *(the first version's central justification)*

**Refuted.** The child is per turn, not per session — see
[Process lifecycle](#process-lifecycle-measured). The abort is ending the very turn that owns the
child, so signalling it is not wrong *in principle*. The escalation was wrong because it fired on
success, having tested a condition that could not distinguish success from failure.

> "The process ages prove the abort destroyed a process that would otherwise have survived."
> *(`claude` child 115s old at 14:52, start time matching `Starting async generator loop` at 14:50:10)*

**Refuted — the observation does not discriminate.** Per-turn spawning produces exactly that reading
with no kill at all: 14:50:10 is simply the next turn starting. The measurement is consistent with
both hypotheses and supports neither.

> "Background subagents die because the abort SIGTERMs the session process."

**Refuted as the primary cause, and not addressed by this fix.** Because the child is per turn, an
in-process background subagent cannot outlive the turn that spawned it — the teardown happens at the
end of *every* turn, with no abort involved. SIGTERM was a second way to kill them; the architectural
one fires every time. This also explains why `run_in_background: false` works without the abort path
being involved at all.

Also ruled out during the original investigation and still ruled out: OOM (60Gi total, 38Gi
available, no kills in `dmesg`) and upstream rate limiting (proxy logging `status=200` throughout).

## Known issues left open

Found while investigating this; each is separate from the abort bug and none is fixed here.

- **Background subagents cannot survive a turn.** *Still open, and still inferred rather than
  observed* — see [Lifecycle tracing](#lifecycle-tracing), which was added to settle it. The next step
  is to run a background subagent and let the turn end without pressing Stop, then read the trace. The
  real fix is architectural: the per-turn one-shot `query()` would have to become a persistent
  streaming session, feeding later user messages into the same child instead of calling `query()` per
  message. Until then, dispatch subagents with `run_in_background: false` so they complete within the
  turn.
- **`node_modules` is stale.** `package.json` and `package-lock.json` both pin
  `@anthropic-ai/claude-agent-sdk@0.3.215`; the installed tree is **0.3.165**. `npm ci` has not been
  run since the bump, so behaviour is being observed against a build the project does not declare.
- **`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000'` is inert.** The string appears nowhere in installed
  0.3.165, so the save/set/restore dance around the `query()` constructor (`:607-632`) currently does
  nothing. Re-check after `npm ci`.
- **`abortedSessionIds` key mismatch.** Abort adds the id it was called with, but the run loop deletes
  by `capturedSessionId` (the provider id). For a brand-new session aborted by app id, `wasAborted`
  reads false and a duplicate terminal `complete` is emitted.
- **`isClaudeSDKSessionActive` returns `undefined`** for an unknown id (`return session && ...`)
  despite its `@returns {boolean}` contract.
- **SIGTERM does not reap grandchildren.** `pgrep -P` matches direct children only, so the child's own
  tool shells are orphaned rather than killed. Process-group signalling would fix it but is unsafe
  unless the child is confirmed to be in its own process group — the server shares one with it
  otherwise, and `process.kill(-pid)` would take the server down.
- **`server/claude-sdk.js.bak`** is an untracked leftover — the pre-customization copy of the file.
  Delete it once it is no longer wanted as a reference.

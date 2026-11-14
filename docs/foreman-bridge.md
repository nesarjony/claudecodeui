# The Foreman bridge

What cloudcli offers Foreman (the autonomous engineering lead): start and drive worker sessions inside a sandbox, hear about everything
they do, and take over a session the owner hands over. Foreman codes its HTTP client against this file; the code is
`server/modules/foreman/`.

- **Foreman -> cloudcli:** HTTP under `/api/foreman`, bearer token, every call that changes a session carries an idempotency key.
- **cloudcli -> Foreman:** every session event is stored first, then pushed to Foreman's intake with a bearer token and retried until
  Foreman acknowledges it. Foreman can always fetch what it missed (`eventsSince`).
- cloudcli is the source of truth for sessions and their events. Foreman keeps its own inbox and reconciles against it.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `FOREMAN_BRIDGE_TOKEN_FILE` | File holding the token Foreman presents (`Authorization: Bearer <token>`), re-read on every request, so rotation needs no restart. No file or an empty one: every route answers 503 `FOREMAN_BRIDGE_DISABLED`. | `~/.config/foreman/bridge-token` |
| `FOREMAN_EVENTS_URL` | Foreman's intake endpoint, where events are POSTed. Unset: nothing is pushed (events are still stored and `eventsSince` works). | none |
| `FOREMAN_EVENTS_TOKEN_FILE` | File holding the token cloudcli presents to the intake, re-read for every push. It is never the bridge token: a leaked intake token cannot drive sessions. Unset: nothing is pushed (events are still stored and `eventsSince` works) and the boot log says so, naming this variable. | none |
| `FOREMAN_WORKTREES_DIR` | Where task worktrees are made. | next to the repository |
| `CLAUDE_CAP_URL`, `CLAUDE_CAP_PROFILE` | Where `cap` sessions go (claude-cap) and under which profile: they use `<url>/profile/<profile>` (see Billing and routing). | `http://127.0.0.1:34817`, `foreman-worker` |

At boot cloudcli warns (once per file, through the log, never printing a token) about a token file that group or others can read or write: keep the bridge token file and the
events token file at mode 600.

Test instance (this branch): `scripts/foreman-test-instance.sh` runs it on `127.0.0.1:3011` with the tokens
`~/.config/foreman-next/bridge-token` (Foreman -> cloudcli) and `~/.config/foreman-next/intake-token` (cloudcli -> Foreman), both mode 600.

## Envelopes and errors

Success: `{ "success": true, "data": ... }`. Failure: `{ "success": false, "error": { "code", "message", "details"? } }` with the HTTP status below.

| Status / code | When |
|---|---|
| 401 `FOREMAN_BRIDGE_UNAUTHORIZED` | Missing or wrong bearer token. |
| 503 `FOREMAN_BRIDGE_DISABLED` | No token configured. |
| 400 `INVALID_REQUEST`, `INVALID_SESSION_ID` | Malformed body, id or query. |
| 400 `IDEMPOTENCY_KEY_REQUIRED` | A call that changes a session has no valid `idempotencyKey`. |
| 400 `SANDBOX_REQUIRED`, `SANDBOX_INVALID` | Session start without a sandbox policy, or one that is malformed or opens more than a worker may have (see Sandbox). Nothing was started. |
| 400 `PERMISSION_MODE_FORBIDDEN` | `permissionMode` is `bypassPermissions` or `auto` on a start, message or compact of a sandboxed session (every session Foreman starts). Nothing ran. |
| 500 `SANDBOX_NOT_RECORDED` | The start could not store its sandbox, or what was stored did not read back as the policy sent. Nothing ran (see Idempotency for the session left behind). |
| 404 `SESSION_NOT_FOUND` | Unknown session. |
| 409 `NOT_SUPERVISED` | The session is neither started by Foreman nor adopted (or it was released): it is not Foreman's to drive. |
| 409 `RUN_IN_PROGRESS` | A turn is running; wait for its `turn_end`, or send with `"interrupt": true`. |
| 409 `IDEMPOTENCY_OUTCOME_UNKNOWN` | See Idempotency. |
| 422 `IDEMPOTENCY_KEY_REUSED` | The key was used for a different call. |
| 502 `TURN_START_FAILED` | The CLI refused the turn at once (the session exists; read its state and events). |

## Idempotency

Every call that changes a session (`POST /sessions`, `.../message`, `.../interrupt`, `.../permission`, `.../model`, `.../compact`,
`.../adopt`, `.../release`) carries `idempotencyKey` in its JSON body: 1-200 characters of letters, digits and `._:-`.

- cloudcli applies a key **at most once**. A repeat of the same call (same operation, same session, same body; the order of the body's keys does not matter, at any depth) gets the **first answer**
  back, with its original HTTP status, and nothing runs again. This holds across a cloudcli restart: the answer is stored.
- A repeat that arrives while the first call is still running waits for it and gets its answer.
- A call that fails does not use up its key: a retry with the same key runs again.
- The same key for a different call: 422 `IDEMPOTENCY_KEY_REUSED`.
- A call that began in a process that then died has no stored answer, and cloudcli cannot know whether its effect happened. It answers a repeat
  with 409 `IDEMPOTENCY_OUTCOME_UNKNOWN` and runs nothing. Read `GET .../state` and `.../events`, then decide; use a new key to try again.
- The same holds when the call took effect but cloudcli could not store its answer (a database failure): the call in hand still gets its answer, the key stays pending, and a repeat gets
  409 `IDEMPOTENCY_OUTCOME_UNKNOWN` instead of running the effect a second time. Only a call that itself fails releases its key.
- A start that fails after the session was created (502 `TURN_START_FAILED`, 500 `SANDBOX_NOT_RECORDED`) leaves that session behind; a retry with the same key creates another.

Suggested keys: `start:<runId>:<attempt>`, `message:<runId>:<position>`. They are opaque to cloudcli.

## Calls

Session ids are cloudcli's stable app session ids. `lastSequence` is the sequence of the newest event cloudcli has stored for the session
(0 for none): it counts only events cloudcli has emitted.

| Call | Body / query | Answer |
|---|---|---|
| `GET /health` | | `{ status: "ok", time }` |
| `POST /sessions` | `projectPath` (a known cloudcli project; a worktree made by `POST /projects/worktree` is one), `prompt`, `sandbox` (required), `idempotencyKey`, and optionally `model`, `billing`, `permissionMode` (`default`, `acceptEdits` or `plan`), `effort`, `title`, `taskId` | 201 `{ sessionId, projectPath, title, model, billing, permissionMode, taskId, status: "running", sandboxed: true }` |
| `POST /sessions/:id/message` | `text`, `idempotencyKey`, optionally `interrupt: true`, `permissionMode` (as for the start) | 202 `{ sessionId, accepted: true, interrupted }` |
| `POST /sessions/:id/interrupt` | `idempotencyKey` | `{ sessionId, interrupted, wasRunning, hadLiveProcess }`; 409 `NOT_RUNNING` when nothing runs |
| `POST /sessions/:id/permission` | `requestId`, `decision: "allow" \| "deny"`, `idempotencyKey`, optionally `reason` | `{ resolved: true }`; 404 `NO_PENDING_PERMISSION` when someone answered first or the run is gone |
| `GET /sessions/:id/permissions` | | `{ permissions: [{ requestId, toolName, input, askedAt }] }`: the prompts waiting now |
| `GET /sessions/:id/state` | | `{ sessionId, status: "running" \| "idle" \| "ended", lastSequence, supervision: "started" \| "adopted" \| "released" \| null }` |
| `GET /sessions/:id/events?after=N&limit=M` | `after` default 0, `limit` default and maximum 500 | `{ sessionId, events: [...], hasMore }`: the events with a sequence above `after`, oldest first; ask again from the last sequence while `hasMore` |
| `POST /sessions/:id/adopt`, `.../release` | `idempotencyKey`, adopt also optionally `taskId` | see Hand-over |
| `POST /sessions/:id/model`, `.../compact` | as before, plus `idempotencyKey` | as before |
| `GET /sessions/:id/digest`, `.../context`, `GET /sessions`, `GET /projects/git`, `POST`/`DELETE /projects/worktree` | unchanged | unchanged |

`status` is `running` while a turn runs or a permission prompt waits, `ended` when the session was stopped or crashed (its newest event is a `session_end`)
and nothing has run since, otherwise `idle`. A session that is `idle` or `ended` can be given another message; that starts a new run.

## Billing and routing

`billing` defaults to `cap` (claude-cap's `foreman-worker` profile, answered by MiniMax) unless the body or the model's `@api` / `@cap` marker says otherwise.
A `cap` session starts with a placeholder API key and no real credential in its environment, and both `ANTHROPIC_BASE_URL` and `ANTHROPIC_LLM_HOST` (the patched CLI
reads the latter for inference) name the profile in the URL, `http://127.0.0.1:34817/profile/foreman-worker`; the `x-claude-cap-profile` header names the same profile
(a different one would be a 400 `profile_conflict`). Only sessions started with `billing: "cap"` get this: a session handed over by the owner (adopted) has no `@cap` marker
and keeps its own settings. claude-cap maps every Claude model name of the profile to MiniMax-M3, caps it at 70% of the five-hour and 80% of the weekly window, and refuses
(429 `profile_quota`) when a cap is reached or the usage is unknown. See the `quota` event.

## Events

Every event of a session Foreman supervises is stored with a unique `id` (`<sessionId>:<sequence>`) and a `sequence` that counts the session's events
from 1 **without gaps**. It is pushed in this shape, and returned in the same shape by `eventsSince`:

```json
{ "id": "ses_ab12:3", "sessionId": "ses_ab12", "sequence": 3, "kind": "turn_end", "payload": { "...": "..." } }
```

| `kind` | `payload` | When |
|---|---|---|
| `turn_end` | `text` (the final message, clipped to 8000 characters), `commitCount`, `headSha`, `claimsDone`, `model`, `usage` | A turn ended without error. |
| `permission_request` | `requestId`, `tool`, `detail` (one line, at most 1000 characters) | A call the sandbox's rules did not settle waits for an answer (`POST .../permission`). |
| `refusal` | `text` | The model refused. One event per refusal; a second signal for it within 30 s is dropped. |
| `error` | `message` | A turn ended with an error result, or the run failed. |
| `quota` | `message` (the sentence the CLI reports, for the ledger) | The worker hit the cap: its requests were refused with a 429 (for a `cap` worker, claude-cap's `profile_quota`) and the turn gave up. **Not a failure and not a crash:** the batch pauses. The event says nothing about when to resume; Foreman decides that from claude-cap's usage windows (`GET http://127.0.0.1:34817/health`, `upstreamUsage.minimax.{fiveHour,weekly}.resetAt`). Sent once instead of the `error` and the `session_end` (`crashed`) that the same failure would otherwise produce; the session stays usable and can be messaged after the reset. |
| `session_end` | `reason`: `stopped` (the run was aborted: `interrupt`) or `crashed` (the run failed) | A run ended abnormally. A run that simply ends after its turn (idle release) emits nothing: the session is idle and can be messaged again. |

- `claimsDone` is true when the **last line** of the turn's final message is exactly `FOREMAN-RESULT: done` (the brief's output contract asks for it). It is a claim, not evidence.
- `commitCount` is what the turn committed in the session's project: commits reachable from `HEAD` that were not at the session's start (or, for an adopted session, at
  adoption) and that earlier `turn_end` events have not reported. Counted from the repository, not from what the worker says.
- `headSha` is the project's `HEAD` when the turn ended (the full commit sha), read from the repository in the same step as `commitCount`; `null` when the project has no commit or is not a
  repository. For a session in a task worktree it is the worktree's `HEAD`. A `turn_end` stored before the field existed is served with `headSha: null`.
- `model` is the model the upstream reported for the turn (or the only model the turn billed), `null` when none was seen. For a `cap` session it must be MiniMax's:
  a Claude model name here is a subscription leak. `usage` is `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`, each a number or `null`, for the
  main loop of the turn (subagent calls are not included). `model`, `usage` and `headSha` are additions to the slice-2 schema; a reader that does not know them ignores them.
- `quota` is new: Foreman's `bridgeEventSchema` must accept it, or its intake rejects the event (and, as the push retries for as long as it takes, holds back that session's later events).
  cloudcli recognises it by the SDK's own classification of the request the CLI gave up on (`rate_limit`, which is what a 429 is), not by wording, and it carries no reset time: the CLI retries a refused request
  about ten times (roughly three minutes) and only then gives up, and the quota's reset time lives in claude-cap's structured usage windows, which Foreman already reads for its allowance gate.
  A 429 that is not claude-cap's quota but the upstream's own limit looks the same; Foreman's check of the usage windows tells them apart (windows below their caps: retry shortly).
- Foreman's schema also lists a `question` event and a `session_end` with reason `completed`. cloudcli never sends them: a sandboxed worker cannot be asked
  anything (`AskUserQuestion` is denied), and a run that ends normally is just idle.
- A permission prompt answered elsewhere (a person in the UI, a timeout) gives no event; the prompt just stops being pending.
- A turn that failed (and that was not a quota refusal) is an `error` and not a `turn_end`, even when the CLI reports it with `subtype: success`.

### Between the runtime and the store

A runtime observation becomes a stored event in memory: cloudcli queues it (one queue per session, so a slow `git` call for one session's turn holds up only that session's later events, and
a session's events are stored in the order they happened) and stores it once its `commitCount` and `headSha` are known. **If cloudcli crashes in that window, the event is lost.** It never
got a sequence, so the numbering stays gap-free and no gap shows. cloudcli keeps no durable queue; Foreman reconciles instead: a session that is `idle` (`GET .../state`) without a `turn_end`
for the turn Foreman started (or an `error`, `quota` or `session_end` that explains it) has lost its event. Compare `lastSequence` with what Foreman holds and fetch the rest with
`eventsSince`, then read `GET .../digest`, which reads the session's transcript and so shows what the turn did, and judge the work from the repository.

### The push

After an event is stored cloudcli POSTs it to `FOREMAN_EVENTS_URL` with `Authorization: Bearer <intake token>` (the content of `FOREMAN_EVENTS_TOKEN_FILE`) and `content-type: application/json`; the body is the event above.

- **Off without a URL or a token file.** With `FOREMAN_EVENTS_URL` or `FOREMAN_EVENTS_TOKEN_FILE` unset nothing is pushed and everything stays owed (stored, and served by `eventsSince`). A token file that is
  named but missing or empty when an event is due leaves that event owed too (logged with `FOREMAN_BRIDGE_DEBUG=1`) and is retried like any failed push.

- **Acknowledgement is any 2xx answer.** Foreman answers a repeat of an event it already has with a 2xx too.
- Anything else, or no answer within 5 s, is retried with a doubling delay (1 s, 2 s, 4 s, ... up to 60 s), for as long as it takes, across cloudcli restarts: what is
  still owed is read back from the store at boot.
- A session's events are pushed strictly in order; an event that is stuck holds back its own session only. Delivery is therefore **at least once, in order per session**: Foreman
  de-duplicates by `id` and restores order by `sequence`.
- If Foreman keeps rejecting an event, it stays owed and keeps being retried every minute; the log (set `FOREMAN_BRIDGE_DEBUG=1`) names it.
- On start-up, and whenever a gap shows, Foreman compares `lastSequence` with what it holds and fetches the rest with `eventsSince`.

## Sandbox

A session started through the bridge is **always sandboxed**. `sandbox` is Foreman's policy for the task, already filled in (absolute paths, nothing to expand):

```json
{
  "scratchDir": "/abs/scratch/batch-1",
  "approvalTimeoutMs": 1800000,
  "network":     { "allowedDomains": [], "allowAllUnixSockets": true },
  "filesystem":  { "denyRead": [], "allowRead": [], "allowWrite": [], "denyWrite": [] },
  "credentials": { "envVars": [{ "name": "ANTHROPIC_API_KEY", "mode": "deny" }] },
  "permissions": { "allow": ["Bash", "Edit(//abs/worktree/**)"], "deny": ["Read(//**/.env*)"] },
  "disallowedTools": ["AskUserQuestion", "ExitPlanMode", "WebFetch", "WebSearch"],
  "env": { "TMPDIR": "/abs/scratch/batch-1/tmp", "CLAUDE_CODE_TMPDIR": "/abs/scratch/batch-1/cc" }
}
```

`scratchDir` must be **at most 64 characters**: the CLI's network bridge makes a unix socket under `<scratchDir>/tmp`, a socket path may be 107 bytes at most, and with a longer directory every Bash call of the session dies with "Sandbox is required but failed to initialize: Failed to create bridge sockets". cloudcli refuses a longer one at the start (`SANDBOX_INVALID`).

It is the old policy builder's filled template with `sandbox` flattened, plus `scratchDir` and `approvalTimeoutMs` (optional, 1 s to 24 h, default 30 minutes). cloudcli
applies it as the SDK `sandbox` option (bubblewrap around every Bash call), merges `permissions` into the run's flag settings (union), adds `disallowedTools` (always with
`AskUserQuestion` and `ExitPlanMode`) to the ones no person can un-deny, and merges `env` into the CLI process environment. It creates `scratchDir`, `scratchDir/tmp` and `scratchDir/cc` first.

- **Fail closed.** No `sandbox`, `null`, or one that fails validation (a missing part, a non-string, a list over 400 entries, a `scratchDir` that is not absolute or is over
  64 characters, or a part that opens more than the rules below allow): 400 `SANDBOX_REQUIRED` / `SANDBOX_INVALID` and **nothing starts**.
- **Recorded before the first run.** The policy is stored with the session by a write that must succeed and is then read back the way the session's runs read it; a failed
  write or a policy that does not read back exactly as sent is a 500 `SANDBOX_NOT_RECORDED` and nothing runs. Every later run (a message, after a restart too) reads the
  stored policy afresh and validates it with the current rules.
- **Which runs fail closed.** Every run the bridge dispatches for a sandboxed session is marked as Foreman's (`foremanSandbox: true` in the turn's options). A stored policy
  applies to every run of its session, marked or not; one that is malformed or fails today's rules refuses every run. With no stored policy a marked run is refused and any
  other runs as before. When the database cannot be read, the policy this process last read or wrote for the session applies; without one a marked run is refused and an
  unmarked one runs as before, so an unreadable state table never stops the owner's own sessions. **Residual risk:** a person typing into a worker session in the UI while
  the table is unreadable and nothing is remembered runs that one turn without the sandbox.
- **Do not deny `Edit`/`Write` on `.git/**`.** The CLI turns every Edit/Write deny rule into a read-only mount in the sandbox, so a deny of the checkout's `.git/**` leaves git unable to write its index, objects and refs:
  `git commit` fails with `Unable to create '.../index.lock': Read-only file system` (measured, real CLI; the old builder's template has exactly these rules). Deny only what must stay protected: `.git/hooks/**` and `.git/config`.
- **A git worktree works if its git directory is opened.** A worktree's git directory is the main repository's `.git`, outside the checkout. Put it in `allowWrite` and `allowRead` (the old builder's `writeDirs`), keep `hooks` and `config` of it
  in `denyWrite` and denied for Edit/Write (writes to them fail with `Read-only file system`, measured), and allow `Read(//<git dir>/**)` for the file tools. `git add` by name and `git commit` then work; `git add -A` does not (the CLI's placeholder files).
- **Forced**, whatever the policy says: `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false` (so `dangerouslyDisableSandbox` is ignored),
  `network.strictAllowlist` (an unlisted host is a deterministic deny, never a prompt), and `AskUserQuestion` and `ExitPlanMode` in the denied tools.
- **Permission modes.** A sandboxed session runs in `default`, `acceptEdits` or `plan`; `bypassPermissions` and `auto` are refused (`PERMISSION_MODE_FORBIDDEN`), because the
  sandbox covers Bash only and the file tools rely on the prompts those modes skip. The runtime holds every sandboxed run to this whatever its options say: another mode becomes
  `default`, the UI's "skip permissions" setting is ignored, plan mode allows no reads or web tools outright, and a mode stored before this rule is not resumed.
- **Validated** (400 `SANDBOX_INVALID`, naming the field), the parts that open something up:
  - `env`: only `TMPDIR`, `CLAUDE_CODE_TMPDIR`, `CI`, `NODE_ENV`, `TZ`, `LANG`, `LC_ALL`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`;
    the two temp directories inside `scratchDir`. (The session's routing is cloudcli's: no `ANTHROPIC_*`, `NODE_OPTIONS`, `LD_PRELOAD`.)
  - `network.allowedDomains`: each `host:port` with a port, no wildcards, not `localhost`, and never cloudcli's port (`SERVER_PORT`, and 3001) or claude-cap's, on any host
    (a name can resolve to this machine).
  - `filesystem.allowRead`, `filesystem.allowWrite` and `scratchDir`: absolute, normalised (no `..`), no patterns, at least three components (not `/`, `/mnt`, `/mnt/dev`,
    `/home/<user>`), not the home directory or above it; a writable one (`allowWrite`, `scratchDir`) never has a `.claude` or `.ssh` component nor reaches into `.git/hooks` or `.git/config`.
  - `permissions.allow`: `Bash` (or `Bash(*)`), `TodoWrite`, `mcp__infigraph` (or one of its tools), and `Read`/`Edit`/`Write`/`NotebookEdit` rules on an absolute `//path`
    that does not start with a wildcard; the write rules are held to the writable-path checks above. Nothing else (bare `Read`/`Edit`/`Write`, `WebFetch`, `WebSearch`, narrower `Bash(...)`).
  - Not checked beyond shape and size: the lists that only close things (`denyRead`, `denyWrite`, `permissions.deny`, `disallowedTools`, `credentials`) and `allowAllUnixSockets`.
- A prompt the rules do not settle becomes a `permission_request` event; `AskUserQuestion` and `ExitPlanMode` are denied at once. A prompt nobody answers within `approvalTimeoutMs` is denied with a
  message that says it was a timeout, not a decision.
- The old regex guard (`guard` in the start body, `guarded` flags, the PreToolUse guard hook) no longer exists.

## Hand-over (BR-2.10)

The owner can hand one of their own cloudcli sessions to Foreman, which then supervises it like a worker.

- `POST /sessions/:id/adopt` `{ idempotencyKey, taskId? }`: the session joins Foreman's supervision **as it is**. Its model, routing (billing) and permission mode are not
  touched, no sandbox is added (it keeps the owner's settings), and it is not marked as a worker. From then on its events are stored with ids and sequence numbers and pushed
  exactly as for a started session, `eventsSince` works, and message, interrupt and permission answers work. Events are counted from adoption: `commitCount` counts commits since
  the project's `HEAD` at that moment. Answer: `{ sessionId, status, lastSequence, supervision: "adopted", projectPath, model, billing }`.
  409 `ALREADY_SUPERVISED` when Foreman already supervises it; 404 for an unknown session.
- Foreman never widens an adopted session: `permissionMode` on `message` / `compact` is refused (400 `PERMISSION_MODE_LOCKED`) and so is `model` (409 `MODEL_LOCKED`).
- `POST /sessions/:id/release` `{ idempotencyKey }`: hand-back. Nothing more is stored or pushed for the session; events already stored are still pushed until acknowledged. The session
  stays alive and carries on as the owner's. Answer: the state (`supervision: "released"`, `lastSequence` = the last event of the hand-over). 409 `NOT_ADOPTED` for a session
  that was not handed over. After release the bridge refuses to drive it (`NOT_SUPERVISED`) until it is adopted again; sequence numbers continue where they left off.
- Visible state: `supervision` in `GET /sessions/:id/state` and in every entry of `GET /sessions`; for the logged-in UI, `GET /api/foreman-suggestions/supervised` (cloudcli login, not
  the bridge token) lists `{ sessions: [{ sessionId, supervision: "started" | "adopted", taskId }] }`.
- Messages, interrupts and permission answers need a supervised session (`started` or `adopted`); any other session answers 409 `NOT_SUPERVISED`. Read-only calls (digest, context, git) work for any.

## What differs from Foreman's slice-2 `Bridge` interface and the simulator

- `startSession` takes `sandbox` (the interface's `model` and `brief` map to `model` and `prompt`; `directory` to `projectPath`).
- `sessionState` also returns `supervision`; `eventsSince` pages (`hasMore`).
- The sequence counts events cloudcli emitted, like the simulator; unlike it, `session_end` is only `stopped` or `crashed` and `question` is never sent.
- Real events carry `model`, `usage` and `headSha` on `turn_end` (additive), and there is a `quota` kind (new).

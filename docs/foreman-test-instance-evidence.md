# Test instance: isolation evidence

Instance: `scripts/foreman-test-instance.sh`, 127.0.0.1:3011, started from this worktree with its own HOME (`~/.local/share/foreman-next/cloudcli-test/home`), database (`.../auth.db`) and tokens (`~/.config/foreman-next/{bridge-token,intake-token}`, mode 600). The live instance (port 3001, `/mnt/dev/frontend/claudecodeui`) was only read: `live-check` before the test instance first started, and again after all the runs (the battery, the quota probe and four real-MiniMax worker runs).

Why its own HOME: cloudcli keeps the plugin directory (`~/.claude-code-ui`), the local-server marker (`~/.cloudcli/local-server.json`, overwritten at start), uploaded assets and Claude transcripts under the home directory. Sharing it would start the live instance's two plugins a second time and overwrite its marker.

## Before

```
live health: 200
live pid: 1345262 started: Sat Nov 14 05:40:35 2026
live checkout: 2b439c29 0 changed files
live plugin processes:
  1261484       1 Sat Nov 14 05:33:22 2026 /usr/bin/node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345428 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345436 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-task-queue/dist/server.js
live marker: 5d9ba42f6cab 2026-11-14 05:40:37.657308146 +0600
plugin dirs: cloudcli-plugin-prism cloudcli-plugin-task-queue  config none
```

## After

```
live health: 200
live pid: 1345262 started: Sat Nov 14 05:40:35 2026
live checkout: 2b439c29 0 changed files
live plugin processes:
  1261484       1 Sat Nov 14 05:33:22 2026 /usr/bin/node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345428 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345436 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-task-queue/dist/server.js
live marker: 5d9ba42f6cab 2026-11-14 05:40:37.657308146 +0600
plugin dirs: cloudcli-plugin-prism cloudcli-plugin-task-queue  config none
```

`diff before after` is empty: same pid and start time, same plugin processes, same marker, health 200 on both.

## After the extended sandbox battery (security fix round)

The extended battery (`scripts/foreman-battery/attack-battery.mts`, two partial dry runs and one full run) restarts the test instance: on a stand-in model and a stand-in
intake while its sessions run, then in its normal configuration. What changed about the instance's isolation:

- The battery puts the instance back with the settings it found (`CLAUDE_CAP_PROFILE`, `FOREMAN_EVENTS_URL`, `FOREMAN_URL`, `FOREMAN_WORKTREES_DIR`, read from the running
  process) and the real claude-cap, so slice 3b's configuration survives a run (here: its intake `http://127.0.0.1:4212/foreman/events`).
- While sessions run, events go to the battery's stand-in intake, which takes only the battery's sessions' events; none is left owed to the instance's normal intake. Another
  session's event is refused there and stays owed for its own intake.
- The stand-in model answers only a conversation that carries the battery's marker; another session sent to it meanwhile gets an error, never the scripted calls.
- The policies the battery expects refused are sent with the instance in its normal configuration; none started anything.

`live-check` after the round, compared with the before-state above (`~/.local/share/foreman-live-before.txt`):

```
live health: 200
live pid: 1345262 started: Sat Nov 14 05:40:35 2026
live checkout: 2b439c29 0 changed files
live plugin processes:
  1261484       1 Sat Nov 14 05:33:22 2026 /usr/bin/node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345428 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-prism/dist/server.js
  1345436 1345262 Sat Nov 14 05:40:37 2026 node /home/nesar/.claude-code-ui/plugins/cloudcli-plugin-task-queue/dist/server.js
live marker: 5d9ba42f6cab 2026-11-14 05:40:37.657308146 +0600
plugin dirs: cloudcli-plugin-prism cloudcli-plugin-task-queue  config none
```

`diff before after` is empty: same pid and start time, same plugin processes, same marker, health 200.

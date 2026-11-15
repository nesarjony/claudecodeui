#!/usr/bin/env bash
# The Foreman test instance of cloudcli: this checkout, on 127.0.0.1:3011, apart from the live instance.
#
#   scripts/foreman-test-instance.sh init           make the state directory, the tokens and the instance's home
#   scripts/foreman-test-instance.sh start          start it (CLAUDE_CAP_URL=<url> start points its workers at another model endpoint)
#   scripts/foreman-test-instance.sh stop|status|restart
#   scripts/foreman-test-instance.sh register-project <path>   make an existing directory a cloudcli project of the test instance (the bridge only drives known projects)
#   scripts/foreman-test-instance.sh live-check     what the live instance and its plugins look like right now (run before and after)
#
# Everything the instance writes lives under STATE. It gets its own HOME because cloudcli keeps the plugin directory
# (~/.claude-code-ui), the "local server" marker (~/.cloudcli/local-server.json), uploaded assets and Claude's transcripts
# (~/.claude) under the home directory: a second instance with the same HOME would start the live instance's plugins and
# overwrite its marker. The real HOME is never read or written by the instance.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FOREMAN_TEST_STATE:-$HOME/.local/share/foreman-next/cloudcli-test}"
CONFIG="${FOREMAN_NEXT_CONFIG:-$HOME/.config/foreman-next}"
PORT=3011
LIVE_PORT=3001
PID_FILE="$STATE/instance.pid"
LOG_FILE="$STATE/instance.log"
INSTANCE_HOME="$STATE/home"

init() {
  umask 077
  mkdir -p "$CONFIG" "$STATE" "$INSTANCE_HOME"
  # The token cloudcli expects from Foreman, and the one it presents to Foreman's intake.
  for name in bridge-token intake-token; do
    [ -s "$CONFIG/$name" ] || openssl rand -hex 32 > "$CONFIG/$name"
    chmod 600 "$CONFIG/$name"
  done
  # Workers commit as this identity; nothing else of the real home is copied.
  [ -f "$INSTANCE_HOME/.gitconfig" ] || printf '[user]\n\tname = nesarMVN\n\temail = nesar@moveon.com.bd\n' > "$INSTANCE_HOME/.gitconfig"
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  # The pid file is only believed while the process is still this instance.
  grep -qa "FOREMAN_TEST_INSTANCE=1" "/proc/$pid/environ" 2>/dev/null || return 1
  echo "$pid"
}

start() {
  init
  if pid="$(running_pid)"; then echo "already running: pid $pid"; return 0; fi
  # An explicit environment: the instance inherits nothing from this shell (tokens, API keys) except what is named here.
  nohup env -i \
    FOREMAN_TEST_INSTANCE=1 \
    HOME="$INSTANCE_HOME" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" USER="$(id -un)" LANG=C.UTF-8 \
    HOST=127.0.0.1 SERVER_PORT="$PORT" \
    DATABASE_PATH="$STATE/auth.db" WORKSPACES_ROOT=/mnt/dev \
    CLAUDE_CLI_PATH="$HOME/.local/bin/claude" \
    CLAUDE_CAP_URL="${CLAUDE_CAP_URL:-http://127.0.0.1:34817}" CLAUDE_CAP_PROFILE="${CLAUDE_CAP_PROFILE:-foreman-worker}" \
    FOREMAN_BRIDGE_TOKEN_FILE="$CONFIG/bridge-token" FOREMAN_EVENTS_TOKEN_FILE="$CONFIG/intake-token" \
    FOREMAN_EVENTS_URL="${FOREMAN_EVENTS_URL:-}" FOREMAN_URL="${FOREMAN_URL:-http://127.0.0.1:4211}" \
    FOREMAN_WORKTREES_DIR="${FOREMAN_WORKTREES_DIR:-/mnt/dev/frontend/foreman-worktrees}" \
    TSX_TSCONFIG_PATH="$ROOT/server/tsconfig.json" \
    node --import tsx "$ROOT/server/index.ts" > "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then echo "started: pid $(cat "$PID_FILE"), http://127.0.0.1:$PORT"; return 0; fi
    sleep 1
  done
  echo "did not come up; see $LOG_FILE" >&2
  return 1
}

stop() {
  if pid="$(running_pid)"; then
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    echo "stopped: pid $pid"
  else
    echo "not running"
  fi
  rm -f "$PID_FILE"
}

status() {
  if pid="$(running_pid)"; then
    echo "pid $pid"; curl -fsS -m 3 "http://127.0.0.1:$PORT/health"; echo
  else
    echo "not running"; return 1
  fi
}

live_check() {
  echo "live health: $(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LIVE_PORT/health")"
  local live
  live="$(ss -ltnp 2>/dev/null | sed -n "s/.*127.0.0.1:$LIVE_PORT .*pid=\([0-9]*\).*/\1/p" | head -1)"
  echo "live pid: $live started: $(ps -o lstart= -p "$live" | xargs)"
  echo "live checkout: $(git -C /mnt/dev/frontend/claudecodeui rev-parse --short HEAD) $(git -C /mnt/dev/frontend/claudecodeui status --short | wc -l) changed files"
  echo "live plugin processes:"
  ps -eo pid,ppid,lstart,cmd | grep -E "claude-code-ui/plugins/[^ ]+/dist/server.js" | grep -v grep | sed 's/^/  /'
  echo "live marker: $(md5sum < "$HOME/.cloudcli/local-server.json" | cut -c1-12) $(stat -c %y "$HOME/.cloudcli/local-server.json")"
  echo "plugin dirs: $(ls "$HOME/.claude-code-ui/plugins" | tr '\n' ' ') config $(stat -c %y "$HOME/.claude-code-ui/plugins.json" 2>/dev/null || echo none)"
}

# The instance's own login (single user), made on first use with a generated password that only the file under CONFIG holds.
login_token() {
  local file="$CONFIG/instance-login" url="http://127.0.0.1:$PORT/api/auth"
  if [ ! -s "$file" ]; then
    umask 077
    printf '{"username":"foreman-test","password":"%s"}\n' "$(openssl rand -hex 16)" > "$file"
    curl -fsS -m 10 -X POST "$url/register" -H 'content-type: application/json' --data-binary @"$file" > /dev/null
  fi
  curl -fsS -m 10 -X POST "$url/login" -H 'content-type: application/json' --data-binary @"$file" | jq -r .token
}

register_project() {
  local path="${1:?path}" token
  token="$(login_token)"
  curl -sS -m 20 -X POST "http://127.0.0.1:$PORT/api/projects/create-project" -H "authorization: Bearer $token" -H 'content-type: application/json' \
    --data "$(jq -n --arg path "$path" '{path: $path}')" | jq -c '{success, path: .project.fullPath, error: .error.code}'
}

case "${1:-}" in
  init) init ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  register-project) register_project "${2:-}" ;;
  live-check) live_check ;;
  *) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac

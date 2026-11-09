#!/bin/bash
# The isolated bb for e2e (03 §E2E on an isolated bb). Never touches the live bb: data in ~/.bb-hermes-e2e,
# ports 48886/48887, every BB_* unset, PATH without a `hermes` executable.
#   e2e/bb-e2e.sh preflight          server only (no host daemon): provider-acp, keep-awake, connect must be disabled
#   e2e/bb-e2e.sh start              preflight, then bb-app (server + host daemon); checks the three again
#   e2e/bb-e2e.sh install <repo>     with bb-app stopped: server only, sbb plugin install <repo> --yes, folder → the test root
#                                    (a reinstall keeps the old machine in data.db: with a daemon up it would reach ~/.hermes)
#   e2e/bb-e2e.sh dev <repo>         sbb plugin dev <repo>, in the background
#   e2e/bb-e2e.sh fake <folder> […]  the strict fake (npm run fake-hermes) in <folder> under /private/tmp/bb-hermes-test/,
#                                    with the fake's flags after it (e.g. --unserved solo)
#   e2e/bb-e2e.sh hermes <folder>    or an isolated Hermes there (e2e/isolated-hermes.ts: stub model, dashboard for Conduit)
#   e2e/bb-e2e.sh connect <folder>   setConnection: the machine = the isolated host daemon, the folder = <folder>
#   e2e/bb-e2e.sh check [<id>]       diagnostics.instance_id must equal <id> (default: the running fake's or Hermes'); else exit 1
#   e2e/bb-e2e.sh stop               stops dev, the fake or Hermes, and bb-app; keeps ~/.bb-hermes-e2e (03 step 8 deletes it: the lead reuses it)
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
data="$HOME/.bb-hermes-e2e"
run=/private/tmp/bb-hermes-test/e2e-bb
mkdir -p "$run"
sbb="$repo/e2e/sbb"
die() { echo "bb-e2e: $*" >&2; exit 1; }

node=$(command -v node)
# A clean environment: BB_* unset; PATH without any dir holding `hermes` (S1-S3 Safety). Not enough on its own:
# the host daemon re-derives the user's PATH, so provider-acp stays disabled (preflight).
clean_env() {
  for v in $(env | sed -n 's/^\(BB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
  # UTC: the bridges inherit it and print card deadlines ("until hh:mm") in it (docs/variables.md).
  export TZ=UTC
  local dirs="" d
  IFS=: read -ra parts <<<"$PATH"
  for d in "${parts[@]}"; do
    [ -n "$d" ] && [ ! -e "$d/hermes" ] && dirs="${dirs:+$dirs:}$d"
  done
  export PATH="$dirs"
  ! command -v hermes >/dev/null || die "hermes still on PATH"
}

up() { curl -fsS -m 2 http://127.0.0.1:48886/health >/dev/null 2>&1; }
alive() { [ -f "$run/$1.pid" ] && kill -0 "$(cat "$run/$1.pid")" 2>/dev/null; }
wait_up() { for _ in $(seq 1 120); do up && return 0; sleep 0.5; done; die "server not healthy (logs: $run, $data/logs)"; }
wait_down() { local pid=$1; for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done; kill -KILL "$pid" 2>/dev/null || true; }

# The three plugins that probe or reach out on a host must be disabled before any host daemon connects.
check_disabled() {
  local list
  list=$("$sbb" plugin list --json)
  node -e '
    const rows = JSON.parse(process.argv[1]);
    const all = Array.isArray(rows) ? rows : rows.plugins ?? rows.items ?? [];
    const bad = ["provider-acp", "keep-awake", "connect"].filter((id) => { const p = all.find((r) => r.id === id); return !p || p.enabled !== false; });
    if (bad.length) { console.error("bb-e2e: not disabled: " + bad.join(", ")); process.exit(1); }
    console.log("provider-acp, keep-awake, connect: disabled");
  ' "$list"
}

preflight() {
  up && die "something already serves :48886"
  [ -d "$data" ] || die "$data missing (P0's isolated bb)"
  ( clean_env
    BB_DATA_DIR="$data" BB_SERVER_PORT=48886 BB_SERVER_BIND_HOST=127.0.0.1 BB_HOST_DAEMON_PORT=48887 BB_SKIP_ONBOARDING=1 NODE_ENV=production \
      nohup "$node" "$repo/node_modules/bb-app/server/dist/index.js" >"$run/server-only.log" 2>&1 &
    echo $! >"$run/server-only.pid" )
  wait_up
  local ok=0
  check_disabled || ok=1
  if [ $ok -ne 0 ]; then
    for id in provider-acp keep-awake connect; do "$sbb" plugin disable "$id" || true; done
    check_disabled
  fi
  # An installed hermes plugin connects as soon as its machine is online: never with a folder outside the test root.
  if "$sbb" plugin list | grep -q '^hermes@'; then
    if ! "$sbb" plugin config hermes | grep -q '^folder = "/private/tmp/bb-hermes-test/'; then
      "$sbb" plugin config hermes set folder /private/tmp/bb-hermes-test/e2e-fake
    fi
    "$sbb" plugin config hermes | grep '^folder = '
  fi
  kill -INT "$(cat "$run/server-only.pid")"
  wait_down "$(cat "$run/server-only.pid")"
  rm -f "$run/server-only.pid"
}

start() {
  preflight
  ( clean_env
    BB_SKIP_ONBOARDING=1 nohup "$node" "$repo/node_modules/bb-app/dist/bb-app.js" --data-dir "$data" --server-port 48886 --host-daemon-port 48887 --no-in-app-updates \
      >"$run/bb-app.log" 2>&1 &
    echo $! >"$run/bb-app.pid" )
  wait_up
  check_disabled
  echo "bb-app pid $(cat "$run/bb-app.pid"); host $(cat "$data/host-id")"
}

# Background jobs of a script ignore SIGINT: dev and the fake get SIGTERM (the fake removes its socket on it),
# with their children; bb-app gets SIGINT, as 03 step 8 says, and handles it.
stop() {
  local p pid
  for p in dev fake hermes bb-app server-only; do
    if alive "$p"; then
      pid=$(cat "$run/$p.pid")
      case $p in dev | fake | hermes) pkill -TERM -P "$pid" 2>/dev/null || true; kill -TERM "$pid" ;; *) kill -INT "$pid" ;; esac
      wait_down "$pid"
    fi
    rm -f "$run/$p.pid"
  done
  echo "stopped; $data kept"
}

case "${1:-}" in
  preflight) preflight ;;
  start) start ;;
  stop) stop ;;
  install)
    [ -n "${2:-}" ] || die "usage: install <repo>"
    alive bb-app && die "stop bb-app first: install runs with the server only, before any host daemon connects"
    up && die "something already serves :48886"
    ( clean_env
      BB_DATA_DIR="$data" BB_SERVER_PORT=48886 BB_SERVER_BIND_HOST=127.0.0.1 BB_HOST_DAEMON_PORT=48887 BB_SKIP_ONBOARDING=1 NODE_ENV=production \
        nohup "$node" "$repo/node_modules/bb-app/server/dist/index.js" >"$run/server-only.log" 2>&1 &
      echo $! >"$run/server-only.pid" )
    wait_up
    "$sbb" plugin install "$2" --yes
    "$sbb" plugin config hermes set folder /private/tmp/bb-hermes-test/e2e-fake
    "$sbb" plugin config hermes | grep '^folder = '
    kill -INT "$(cat "$run/server-only.pid")"
    wait_down "$(cat "$run/server-only.pid")"
    rm -f "$run/server-only.pid" ;;
  dev)
    [ -n "${2:-}" ] || die "usage: dev <repo>"
    alive dev && die "dev already running"
    ( cd "$2"; nohup "$sbb" plugin dev "$2" >"$run/dev.log" 2>&1 & echo $! >"$run/dev.pid" )
    echo "plugin dev pid $(cat "$run/dev.pid") (log $run/dev.log)" ;;
  fake | hermes)
    case "${2:-}" in /private/tmp/bb-hermes-test/*) ;; *) die "usage: $1 </private/tmp/bb-hermes-test/…>" ;; esac
    alive fake || alive hermes && die "a Hermes folder is already served"
    rm -f "$run/fake.json" "$run/hermes.json"
    entry=test/fake-hermes/run.ts; [ "$1" = hermes ] && entry=e2e/isolated-hermes.ts
    ( cd "$repo"; nohup node --import tsx "$entry" "$2" "${@:3}" >"$run/$1.json" 2>"$run/$1.log" & echo $! >"$run/$1.pid" )
    for _ in $(seq 1 240); do [ -s "$run/$1.json" ] && break; alive "$1" || die "$1 exited (log $run/$1.log)"; sleep 0.5; done
    cat "$run/$1.json" ;;
  connect)
    [ -n "${2:-}" ] || die "usage: connect <folder>"
    printf '{"machine":"%s","folder":"%s"}' "$(cat "$data/host-id")" "$2" >"$run/connect.json"
    "$sbb" plugin rpc call hermes setConnection --input-file "$run/connect.json" --json ;;
  check)
    served=$run/fake.json; alive hermes && served=$run/hermes.json
    want=${2:-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).instance_id)' "$served")}
    got=$("$sbb" plugin rpc call hermes diagnostics --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.result??j).instance_id)})')
    [ "$got" = "$want" ] || die "diagnostics.instance_id is $got, not $want: abort (R3 M3)"
    echo "instance_id ok: $got" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
set -euo pipefail
umask 077

# Re-enter with only tool lookup, never the developer's credentials or app settings.
if [[ "${1:-}" != "--isolated" ]]; then
  exec env -i PATH="$PATH" LANG=C.UTF-8 bash "$0" --isolated "$@"
fi
shift
[[ "$(uname -s)" == Linux ]] || { echo 'Linux native display requires Linux.' >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
mkdir -p .cache
session="$(mktemp -d "$root/.cache/native-display-XXXXXX")"
chmod 700 "$session"
export HOME="$session/home" TMPDIR="$session/tmp" XDG_RUNTIME_DIR="$session/runtime"
export XDG_CONFIG_HOME="$HOME/config" XDG_DATA_HOME="$HOME/data"
export XDG_CACHE_HOME="$HOME/cache" XDG_STATE_HOME="$HOME/state"
mkdir -p "$HOME" "$TMPDIR" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
# No inherited desktop bus or user services. Keep the socket and Xauthority project-local.
dbus-daemon --session --nofork --address="unix:path=$XDG_RUNTIME_DIR/bus" --print-address >"$session/bus-address" 2>"$session/dbus.log" &
bus=$!
cleanup() {
  kill -TERM "$bus" 2>/dev/null || true
  for _ in {1..40}; do kill -0 "$bus" 2>/dev/null || break; sleep 0.05; done
  kill -KILL "$bus" 2>/dev/null || true
  wait "$bus" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in {1..100}; do
  [[ -S "$XDG_RUNTIME_DIR/bus" ]] && break
  kill -0 "$bus" 2>/dev/null || { echo 'Private DBus exited.' >&2; exit 1; }
  sleep 0.05
done
[[ -S "$XDG_RUNTIME_DIR/bus" ]] || { echo 'Private DBus did not start.' >&2; exit 1; }
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
# The nested script expands variables only after entering the owned X display.
# shellcheck disable=SC2016
xvfb-run -a -s '-screen 0 1280x1024x24' bash -c '
  set -euo pipefail
  session="$1"; root="$2"; bundle="$3"
  openbox --sm-disable >"$session/openbox.log" 2>&1 &
  wm=$!
  cleanup() {
    kill -TERM "$wm" 2>/dev/null || true
    for _ in {1..40}; do kill -0 "$wm" 2>/dev/null || break; sleep 0.05; done
    kill -KILL "$wm" 2>/dev/null || true
    wait "$wm" 2>/dev/null || true
  }
  trap cleanup EXIT
  trap "exit 130" INT
  trap "exit 143" TERM
  ready=false
  for _ in {1..100}; do
    if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "window id #"; then ready=true; break; fi
    kill -0 "$wm" 2>/dev/null || { echo "Owned Openbox exited." >&2; exit 1; }
    sleep 0.05
  done
  "$ready" || { echo "Owned window manager did not start." >&2; exit 1; }
  bun scripts/check-native.ts "$bundle"
' _ "$session" "$root" "${1:-$root/build/linux-native-ci/dev-linux-x64/MCPGateway-dev}"

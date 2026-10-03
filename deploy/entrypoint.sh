#!/bin/bash
# ============================================================================
#  Container entrypoint for the all-in-one desktop image (Dockerfile.desktop).
#
#  Runs two things and dies if either dies, so Kubernetes restarts the pod
#  rather than leaving a half-working desktop behind:
#    1. the web client (Node)  -> :3000
#    2. the desktop           -> Xtigervnc :1 + websockify :6900
#
#  If XFCE/TigerVNC already live in a different pod, use Dockerfile (web
#  client only) instead and you do not need this script.
# ============================================================================
set -uo pipefail

WEB_PID=""
DESK_PID=""

cleanup() {
    echo "Shutting down..."
    [ -n "$WEB_PID" ]  && kill "$WEB_PID"  2>/dev/null
    [ -n "$DESK_PID" ] && kill "$DESK_PID" 2>/dev/null
    wait 2>/dev/null
    exit 0
}
trap cleanup TERM INT

echo "Starting web client on :${PORT:-3000}..."
node /app/server/app.js &
WEB_PID=$!

# Give the web client a moment so its failures surface early and loudly
sleep 1
kill -0 "$WEB_PID" 2>/dev/null || {
    echo "Web client failed to start" >&2
    exit 1
}

echo "Starting desktop..."
/usr/local/bin/start-desktop &
DESK_PID=$!

# Exit as soon as either child exits; the container runtime restarts us
wait -n "$WEB_PID" "$DESK_PID"
echo "A component exited; terminating so the pod restarts cleanly."
exit 1
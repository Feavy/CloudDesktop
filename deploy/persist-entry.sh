#!/bin/bash
# ============================================================================
#  Persistence entrypoint for the CloudDesktop desktop images.
#
#  PERSIST_MODE selects what survives a pod restart:
#
#    off    no persistence (the default when no persistence variable is set).
#           The command is exec'd unchanged.
#
#    delta  store only the filesystem's delta on a PVC and copy it back at
#           startup; see deploy/delta-persist.py. Needs no added capabilities
#           and no privileged mode -- only runAsUser: 0, because reading and
#           restoring the whole root filesystem takes root. The desktop itself
#           is still started as the unprivileged DESKTOP_USER.
#
#    full   the original pivot_root(2) implementation, which copies the whole
#           root filesystem to the volume. That needs runAsUser: 0 plus
#           SYS_ADMIN/SYS_CHROOT/SETUID/SETGID/CHOWN and an unconfined
#           seccomp/AppArmor profile; see deploy/pivot-root.sh.
#
#  PERSIST_MODE=auto (the default) keeps the old behaviour: ROOT_PERSIST_DIR
#  alone means full, PERSIST_DIR alone means delta, neither means off.
#
#  The persistent volume path is PERSIST_DIR, falling back to the historic
#  ROOT_PERSIST_DIR and then /persist.
# ============================================================================
set -Eeuo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "persist-entry: $*" >&2; }

die() {
    local status="$1"
    shift
    {
        echo
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        echo "!! Persistence is not configured correctly; refusing to start."
        echo "!!"
        printf '!! %s\n' "$@"
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    } >&2
    exit "$status"
}

find_pivot() {
    local candidate
    for candidate in "${SELF_DIR}/pivot-root" "${SELF_DIR}/pivot-root.sh" \
                     /usr/local/bin/pivot-root; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

find_helper() {
    local candidate
    for candidate in "${DELTA_PERSIST_HELPER:-}" "${SELF_DIR}/delta-persist.py" \
                     /usr/local/lib/clouddesktop/delta-persist.py; do
        [ -n "$candidate" ] || continue
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

resolve_mode() {
    case "${PERSIST_MODE:-auto}" in
        ""|auto)
            if [ -n "${ROOT_PERSIST_DIR:-}" ]; then
                echo full
            elif [ -n "${PERSIST_DIR:-}" ]; then
                echo delta
            else
                echo off
            fi
            ;;
        off|none|false|0|no)
            echo off
            ;;
        full|delta)
            echo "$PERSIST_MODE"
            ;;
        *)
            die 2 "PERSIST_MODE='${PERSIST_MODE}' is not one of off, delta or full."
            ;;
    esac
}

PERSIST_PATH="${PERSIST_DIR:-${ROOT_PERSIST_DIR:-/persist}}"
MODE="$(resolve_mode)"

if [ "$#" -eq 0 ]; then
    die 2 "No command was given to run."
fi

case "$MODE" in
    off)
        exec "$@"
        ;;
    full)
        PIVOT_BIN="$(find_pivot)" || die 2 "deploy/pivot-root.sh is missing from this image."
        export ROOT_PERSIST_DIR="$PERSIST_PATH"
        if [ -x "$PIVOT_BIN" ]; then
            exec "$PIVOT_BIN" "$@"
        fi
        exec bash "$PIVOT_BIN" "$@"
        ;;
    delta)
        ;;
esac

# ── Delta mode ──────────────────────────────────────────────────────────────

DELTA_FAIL_MESSAGE=(
    "PERSIST_MODE=delta needs the container to run as root (runAsUser: 0)."
    "It does NOT need privileged: true, any capabilities.add, or a special"
    "seccomp/AppArmor profile."
    ""
    "securityContext:"
    "  runAsUser: 0"
    "  runAsGroup: 0"
    "  readOnlyRootFilesystem: false   # delta restore writes to /"
    ""
    "Delta mode relies on the default container capability set (SETUID,"
    "SETGID, CHOWN, DAC_OVERRIDE and FOWNER). If you drop ALL capabilities,"
    "add those back; delta mode itself asks for none."
)

if [ "$(id -u)" -ne 0 ]; then
    die 1 "delta mode is running as uid $(id -u) ($(id -un))." \
          "${DELTA_FAIL_MESSAGE[@]}"
fi

HELPER="$(find_helper)" || die 2 \
    "the delta persistence helper (delta-persist.py) is missing from this image."

command -v python3 >/dev/null 2>&1 \
    || die 2 "python3 is missing from this image; the delta helper needs it."

case "$PERSIST_PATH" in
    /*) ;;
    *) die 2 "PERSIST_DIR must be an absolute path (got '${PERSIST_PATH}')." ;;
esac

mkdir -p "$PERSIST_PATH" 2>/dev/null \
    || die 1 "cannot create the persistence directory '${PERSIST_PATH}'."
if [ ! -w "$PERSIST_PATH" ]; then
    die 1 "the persistence directory '${PERSIST_PATH}' is not writable."
fi
if command -v mountpoint >/dev/null 2>&1 && ! mountpoint -q "$PERSIST_PATH"; then
    log "warning: '${PERSIST_PATH}' is not a mount point; the delta will live in"
    log "warning: the container's writable layer and will not survive the pod."
fi

# Restoring the delta writes to /, so a read-only root cannot work in this mode.
# The probe uses the helper's reserved temp prefix so a crash between create
# and removal cannot turn it into a persisted file.
WRITE_TEST="/.clouddesktop-delta-tmp-write-test.$$"
if ! ( : > "$WRITE_TEST" ) 2>/dev/null; then
    die 1 "the container root filesystem is not writable." \
          "Set readOnlyRootFilesystem: false for PERSIST_MODE=delta."
fi
rm -f "$WRITE_TEST"

# Extra excludes are relative paths/globs; see the README.
delta() {
    python3 "$HELPER" --root / --exclude "${PERSIST_EXCLUDE:-}" "$@"
}

log "restoring the delta from '${PERSIST_PATH}'..."
if ! delta restore --store "$PERSIST_PATH"; then
    die 1 "restoring the filesystem delta from '${PERSIST_PATH}' failed." \
          "The previous state was not applied; fix the volume and restart."
fi

# ── Drop the desktop itself back to an unprivileged user ───────────────────
DROP_USER="${PERSISTENT_ROOT_USER:-${DESKTOP_USER:-ubuntu}}"
DROP_UID=""
DROP_GID=""
DROP_HOME=""
if [ "$DROP_USER" != "root" ]; then
    command -v setpriv >/dev/null 2>&1 \
        || die 2 "cannot drop to '${DROP_USER}': setpriv is missing from the image."

    PW_ENTRY="$(getent passwd "$DROP_USER" 2>/dev/null || true)"
    if [ -z "$PW_ENTRY" ]; then
        die 2 "user '${DROP_USER}' has no passwd entry." \
              "Set DESKTOP_USER or PERSISTENT_ROOT_USER to a user in the image."
    fi
    DROP_UID="$(printf '%s' "$PW_ENTRY" | cut -d: -f3)"
    DROP_GID="$(printf '%s' "$PW_ENTRY" | cut -d: -f4)"
    DROP_HOME="$(printf '%s' "$PW_ENTRY" | cut -d: -f6)"

    if [ "$DROP_UID" = "0" ]; then
        die 2 "user '${DROP_USER}' is uid 0." \
              "Set PERSISTENT_ROOT_USER to the unprivileged desktop user, or"
              "to 'root' to keep root on purpose."
    fi

    if ! DROP_ERR="$(setpriv --reuid="$DROP_UID" --regid="$DROP_GID" \
                     --init-groups /bin/true 2>&1)"; then
        die 2 "cannot drop privileges to '${DROP_USER}' (uid ${DROP_UID}): " \
              "${DROP_ERR:-setpriv failed.}" \
              "The default container capability set includes SETUID/SETGID;" \
              "add them back if the pod drops ALL capabilities."
    fi
fi

# ── Periodic sync ───────────────────────────────────────────────────────────
SYNC_INTERVAL="${PERSIST_SYNC_INTERVAL:-300}"
case "$SYNC_INTERVAL" in
    ''|*[!0-9]*) die 2 "PERSIST_SYNC_INTERVAL must be a non-negative integer." ;;
esac

log "starting the periodic sync (every ${SYNC_INTERVAL}s)..."
delta loop --store "$PERSIST_PATH" --interval "$SYNC_INTERVAL" &
SYNC_PID=$!

# ── Supervise the desktop ──────────────────────────────────────────────────
# Starting tini is the image's CMD, so keep the command as given when it
# already begins with tini (avoids nesting two of them). If a caller overrides
# CMD with a raw process, wrap it so orphaned children are still reaped.
CHILD_CMD=("$@")
if [ "${CHILD_CMD[0]##*/}" = "tini" ] && [ "${CHILD_CMD[1]:-}" = "--" ]; then
    CHILD_CMD=("${CHILD_CMD[@]:2}")
fi
if command -v tini >/dev/null 2>&1; then
    CHILD_CMD=(tini -- "${CHILD_CMD[@]}")
fi

if [ -n "$DROP_UID" ]; then
    if [ -n "$DROP_HOME" ] && [ -d "$DROP_HOME" ]; then
        cd "$DROP_HOME"
    fi
    CHILD_CMD=(setpriv --reuid="$DROP_UID" --regid="$DROP_GID" --init-groups \
               env HOME="$DROP_HOME" USER="$DROP_USER" LOGNAME="$DROP_USER" \
               "${CHILD_CMD[@]}")
fi

CHILD_PID=""
finish_sync() {
    if [ -n "${SYNC_PID:-}" ]; then
        kill -TERM "$SYNC_PID" 2>/dev/null || true
        wait "$SYNC_PID" 2>/dev/null || true
        SYNC_PID=""
    fi
    if ! delta sync --store "$PERSIST_PATH"; then
        log "warning: the final delta sync failed; the last periodic sync is"
        log "warning: still on the volume, but changes since then may be lost."
    fi
}

shutdown() {
    local signal="$1"
    trap - TERM INT
    log "received SIG${signal}; shutting down..."
    if [ -n "$CHILD_PID" ]; then
        kill -TERM "$CHILD_PID" 2>/dev/null || true
        wait "$CHILD_PID" 2>/dev/null || true
        CHILD_PID=""
    fi
    finish_sync
    if [ "$signal" = "TERM" ]; then
        exit 143
    fi
    exit 130
}
trap 'shutdown TERM' TERM
trap 'shutdown INT' INT

log "starting '${CHILD_CMD[*]}'..."
"${CHILD_CMD[@]}" &
CHILD_PID=$!

set +e
wait "$CHILD_PID"
STATUS=$?
set -e
CHILD_PID=""

log "desktop exited with status ${STATUS}; syncing the delta..."
finish_sync
exit "$STATUS"

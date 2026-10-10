#!/bin/bash
# ============================================================================
#  Persistent-root entrypoint for the desktop images.
#
#  With PERSISTENT_ROOT_DIR unset (the default) this is a pure pass-through:
#  the command it is given -- "/usr/bin/tini -- <the image's entrypoint>" --
#  starts exactly as it did before this script existed.
#
#  With PERSISTENT_ROOT_DIR=/some/volume it copies the image's root filesystem
#  into that directory once, remounts the runtime filesystems kubelet hands the
#  container (/etc/hosts, /etc/resolv.conf, /etc/hostname, the service account
#  token, /proc, /sys, /dev and a tmpfs on /tmp and /run), calls pivot_root(2)
#  into the copy and only then starts tini. Everything written afterwards --
#  installed packages, $HOME, the XFCE session's state -- lands on the volume
#  instead of the container's writable layer, so it survives pod restarts.
#
#  pivot_root(2) needs a real uid of 0 and CAP_SYS_ADMIN, so the container has
#  to override the image's unprivileged USER with runAsUser: 0 and add the
#  capabilities in print_pivot_requirements below. Any failure while preparing
#  the persistent root prints that securityContext and exits, rather than
#  starting a desktop that silently is not persistent.
# ============================================================================
set -Eeuo pipefail

# Where the persistent root lives, and the command to run once we are in it
# (e.g. "tini -- start-desktop").
TARGET="${PERSISTENT_ROOT_DIR:-}"

# The user to run the desktop as. The desktop images must not run as root
# (Xtigervnc and XFCE both misbehave and leave root-owned files behind), so once
# the root-only pivot is done we drop back to the user install.sh settled on.
DROP_USER="${PERSISTENT_ROOT_USER:-${DESKTOP_USER:-ubuntu}}"

print_pivot_requirements() {
    cat >&2 <<EOF

  PERSISTENT_ROOT_DIR needs a privileged container. Add this to the pod spec of
  this container:

    securityContext:
      runAsUser: 0
      runAsGroup: 0
      appArmorProfile:
        type: Unconfined
      seccompProfile:
        type: Unconfined
      capabilities:
        add: ["SYS_ADMIN", "SYS_CHROOT", "SETUID", "SETGID", "CHOWN"]
    hostUsers: false

  The image's own USER is deliberately unprivileged, so runAsUser: 0 is what
  overrides it; SYS_ADMIN is what pivot_root(2) needs, and the other four keep
  the privilege drop back to "${DROP_USER}" working. hostUsers: false matters on
  clusters that use user namespaces.

  Also check that:
    * PERSISTENT_ROOT_DIR is an absolute path to a writable directory,
    * a volume is mounted there -- otherwise the root is not persistent,
    * the volume has room for a copy of the image's root filesystem,
    * no volume is mounted anywhere else: mounts under the old root are gone
      after the pivot (this script remounts kubelet's /etc/hosts,
      /etc/resolv.conf, /etc/hostname, the service account token and
      /proc, /sys, /dev for you).
EOF
}

pivot_fail() {
    # Disarm first: the ERR trap fires on a failing command even without
    # errexit, so a failure inside this handler would call it again.
    trap - ERR
    set +e
    local status="$1"
    local message="${2:-}"

    {
        echo
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        echo "!! PERSISTENT_ROOT_DIR='${TARGET}' is set, but the pivot root failed"
        echo "!! (exit status ${status})."
        if [ -n "$message" ]; then
            echo "!! ${message}"
        fi
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    } >&2

    print_pivot_requirements
    echo >&2
    echo "Refusing to start without the persistent root." >&2
    exit "$status"
}

if [ "$#" -eq 0 ]; then
    echo "pivot-root: no command given to run" >&2
    exit 2
fi

# Nothing to do: hand the command straight to the runtime, exactly as the
# image's ENTRYPOINT did before.
if [ -z "$TARGET" ]; then
    exec "$@"
fi

# From here on every failure is a pivot-root failure and gets the explanation.
trap 'pivot_fail "$?" "The failing command was: $BASH_COMMAND"' ERR

NEW="${TARGET%/}"
NEW="${NEW:-/}"
case "$NEW" in
    /)
        pivot_fail 1 "PERSISTENT_ROOT_DIR must be a directory below '/', not '/'."
        ;;
    /*)
        ;;
    *)
        pivot_fail 1 "PERSISTENT_ROOT_DIR must be an absolute path (got '${TARGET}')."
        ;;
esac

if [ "$(id -u)" -ne 0 ]; then
    pivot_fail 1 "pivot_root(2) needs uid 0; this process is uid $(id -u) ($(id -un))."
fi

for tool in pivot_root mount umount mountpoint tar; do
    command -v "$tool" >/dev/null 2>&1 || pivot_fail 1 "the '${tool}' utility is missing from the image."
done

mkdir -p "$NEW"

if ! mountpoint -q "$NEW"; then
    echo "pivot-root: warning: '${NEW}' is not a mount point, so the root will not" >&2
    echo "pivot-root: warning: survive this container and may fill the writable layer." >&2
fi

# ── Seed the persistent root, once ──────────────────────────────────────────
# --one-file-system keeps every other mount out of the copy: the volume itself,
# /dev/shm and kubelet's single-file /etc/{hosts,resolv.conf,hostname} mounts.
SEED_MARKER="$NEW/.seeded"
if [ ! -f "$SEED_MARKER" ]; then
    echo "pivot-root: seeding '${NEW}' from the image's root filesystem (one time)..."
    tar -C / --one-file-system \
        --exclude="./${NEW#/}" \
        --exclude=./proc --exclude=./sys --exclude=./dev \
        --exclude=./tmp --exclude=./run \
        -cf - . | tar -C "$NEW" -xpf -

    mkdir -p "$NEW"/{proc,sys,dev,tmp,run,.oldroot}
    touch "$NEW/etc/hosts" "$NEW/etc/resolv.conf" "$NEW/etc/hostname"
    mkdir -p "$NEW/var/run/secrets/kubernetes.io/serviceaccount"
    touch "$SEED_MARKER"
    echo "pivot-root: seeding done."
fi
mkdir -p "$NEW/.oldroot"

# ── Resolve, and pre-flight, the privilege drop ─────────────────────────────
# The passwd entry is read from the persistent root, not from the running one,
# because that is the one setpriv will use after the pivot. The drop is tried
# for real now: once we exec the real entrypoint there is nothing left to catch
# a missing SETUID/SETGID and explain it.
DROP_UID=""
DROP_GID=""
DROP_HOME=""
if [ "$DROP_USER" != "root" ]; then
    command -v setpriv >/dev/null 2>&1 || pivot_fail 1 "cannot drop privileges: the 'setpriv' utility is missing from the image."

    PW_ENTRY="$(grep -m1 "^${DROP_USER}:" "$NEW/etc/passwd" 2>/dev/null || true)"
    if [ -z "$PW_ENTRY" ]; then
        pivot_fail 1 "user '${DROP_USER}' has no entry in ${NEW}/etc/passwd; set PERSISTENT_ROOT_USER or DESKTOP_USER to a user the image creates."
    fi
    DROP_UID="$(printf '%s' "$PW_ENTRY" | cut -d: -f3)"
    DROP_GID="$(printf '%s' "$PW_ENTRY" | cut -d: -f4)"
    DROP_HOME="$(printf '%s' "$PW_ENTRY" | cut -d: -f6)"

    if [ "$DROP_UID" = "0" ]; then
        pivot_fail 1 "user '${DROP_USER}' is uid 0; set PERSISTENT_ROOT_USER to the unprivileged desktop user (or to 'root' to keep root on purpose)."
    fi

    if ! DROP_ERR="$(setpriv --reuid="$DROP_UID" --regid="$DROP_GID" --init-groups /bin/true 2>&1)"; then
        pivot_fail 1 "cannot drop privileges to '${DROP_USER}' (uid ${DROP_UID}): ${DROP_ERR:-setpriv failed.}"
    fi
fi

# ── Remount what kubelet provided, inside the persistent root ───────────────
# The three files below are bind mounts into the container; copy their contents
# so DNS resolution and the hostname keep working after the pivot.
for f in /etc/hosts /etc/resolv.conf /etc/hostname; do
    if [ -e "$f" ]; then
        rm -f "$NEW$f"
        cat "$f" > "$NEW$f"
    fi
done

# The service account token must stay a live mount: it is rotated in place.
SA=/var/run/secrets/kubernetes.io/serviceaccount
if mountpoint -q "$SA"; then
    mkdir -p "$NEW$SA"
    mountpoint -q "$NEW$SA" || mount --rbind "$SA" "$NEW$SA"
fi

mountpoint -q "$NEW/proc" || mount --rbind /proc "$NEW/proc"
mountpoint -q "$NEW/sys"  || mount --rbind /sys  "$NEW/sys" \
    || echo "pivot-root: warning: could not mount /sys; some tools will not work" >&2
mountpoint -q "$NEW/dev"  || mount --rbind /dev  "$NEW/dev"

# A fresh tmpfs for both, so nothing from the container's writable layer leaks
# into the persistent root and /tmp always arrives world-writable.
mountpoint -q "$NEW/tmp" || mount -t tmpfs -o mode=1777,size=2g,nosuid,nodev tmpfs "$NEW/tmp"
mountpoint -q "$NEW/run" || mount -t tmpfs -o mode=1777,size=256m,nosuid,nodev tmpfs "$NEW/run"

# Webcams, when the pod was given one: a persistent root must not carry the
# device nodes over from a previous run.
for v in "$NEW"/dev/video*; do
    [ -e "$v" ] && mount --bind /dev/null "$v" || true
done

# ── pivot_root(2) ───────────────────────────────────────────────────────────
# pivot_root rejects shared mounts and wants the new root to be a mount point.
mount --make-rprivate /
mountpoint -q "$NEW" || mount --bind "$NEW" "$NEW"
cd "$NEW"
pivot_root . .oldroot
cd /
umount -l /.oldroot
rmdir /.oldroot
echo "pivot-root: running on the persistent root at '${NEW}'"

# ── Hand over to tini as the image's unprivileged user ──────────────────────
if [ -n "$DROP_UID" ]; then
    echo "pivot-root: starting '${*}' as ${DROP_USER} (uid ${DROP_UID}, gid ${DROP_GID})"
    exec setpriv --reuid="$DROP_UID" --regid="$DROP_GID" --init-groups \
        env HOME="$DROP_HOME" USER="$DROP_USER" LOGNAME="$DROP_USER" "$@"
fi

exec "$@"

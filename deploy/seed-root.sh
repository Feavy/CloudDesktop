#!/bin/bash
# ============================================================================
#  Seed a direct-mode persistence volume with the image's filesystem.
#
#  This is the initContainer of PERSIST_MODE=direct (see
#  deploy/kubernetes-desktop-direct.yaml). It copies the image's persistent
#  top-level directories (/etc, /home, /usr, ...) into the PersistentVolume
#  once; the main container then mounts each of those directories from the
#  volume with a Kubernetes subPath volumeMount. The kubelet performs the
#  mounts, so nothing in the pod needs mount(2), an added capability or
#  privileged mode -- and every later write lands on the volume directly.
#
#  Usage:
#      seed-root.sh --persist /persist [--root /] [--mounts "etc home ..."]
#
#  PERSIST_MOUNTS lists the directories to seed and must match the main
#  container's subPath volumeMounts. A per-directory marker under
#  <PERSIST>/.clouddesktop-seed/ makes the seed resumable and lets the main
#  container verify that each mounted directory really came from the seed.
#
#  A volume previously seeded by PERSIST_MODE=full is adopted in place (it has
#  the same layout and a <PERSIST>/.seeded marker), so switching an existing
#  full volume to direct mode does not overwrite the user's files.
#
#  PERSIST_SEED_FORCE=1 re-seeds every listed directory from the image,
#  discarding what was persisted there. Use it only to reset a volume.
# ============================================================================
set -Eeuo pipefail

# Keep the marker files readable by the main container when it runs as the
# unprivileged desktop user: it mounts the volume read-only at PERSIST_DIR and
# reads the markers to validate the deployment.
umask 022

DEFAULT_MOUNTS="etc home opt root srv usr var"

log() { echo "seed-root: $*" >&2; }

die() {
    local status="$1"
    shift
    {
        echo
        printf 'seed-root: %s\n' "$@"
    } >&2
    exit "$status"
}

usage() {
    cat >&2 <<EOF
usage: seed-root.sh [--root DIR] [--persist DIR] [--mounts "DIR ..."]

  --root DIR       filesystem to copy from (default: /)
  --persist DIR    volume to seed (default: /persist)
  --mounts "..."   directories relative to the root (default: $DEFAULT_MOUNTS)
                   overrides PERSIST_MOUNTS
EOF
}

SRC_ROOT="/"
DEST="/persist"
MOUNTS="${PERSIST_MOUNTS:-$DEFAULT_MOUNTS}"
FORCE="${PERSIST_SEED_FORCE:-0}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --root)
            [ "$#" -ge 2 ] || die 2 "--root needs a directory"
            SRC_ROOT="$2"
            shift 2
            ;;
        --persist)
            [ "$#" -ge 2 ] || die 2 "--persist needs a directory"
            DEST="$2"
            shift 2
            ;;
        --mounts)
            [ "$#" -ge 2 ] || die 2 "--mounts needs a list"
            MOUNTS="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die 2 "unknown argument: $1"
            ;;
    esac
done

[ -d "$SRC_ROOT" ] || die 2 "source root '$SRC_ROOT' is not a directory."

mkdir -p "$DEST" 2>/dev/null \
    || die 1 "cannot create the persistence directory '$DEST'."
DEST="$(cd "$DEST" && pwd -P)" \
    || die 1 "cannot resolve the persistence directory."
SRC_ROOT="$(cd "$SRC_ROOT" && pwd -P)" \
    || die 1 "cannot resolve the source root."

[ "$DEST" != "/" ] \
    || die 2 "the persistence directory must not be '/'."

if [ "$(id -u)" -ne 0 ] && [ "$SRC_ROOT" = "/" ]; then
    die 1 "seeding the real root filesystem requires uid 0."
fi

if [ "$SRC_ROOT" = "/" ] && command -v mountpoint >/dev/null 2>&1 \
        && ! mountpoint -q "$DEST"; then
    log "warning: '$DEST' is not a mount point; the seed will live in the"
    log "warning: container's writable layer and will not survive the pod."
fi

# A write probe, so a read-only or full volume fails here with a clear message
# instead of halfway through the copy.
PROBE="$DEST/.clouddesktop-seed-tmp-write-test.$$"
if ! ( : > "$PROBE" ) 2>/dev/null; then
    die 1 "the persistence directory '$DEST' is not writable."
fi
rm -f "$PROBE"

# ── Path validation ─────────────────────────────────────────────────────────
# Only directories relative to the root; no traversal, no hidden names (the
# volume's own marker directories live at its root), and no kernel/runtime
# filesystems.
normalize_rel() {
    local rel="$1" part
    local -a parts
    rel="${rel#/}"
    rel="${rel%/}"
    [ -n "$rel" ] || return 1
    case "$rel" in
        *'//'*) return 1 ;;
    esac
    IFS='/' read -r -a parts <<< "$rel"
    for part in "${parts[@]}"; do
        case "$part" in
            ''|.|..|.*) return 1 ;;
        esac
    done
    printf '%s\n' "$rel"
}

# Where the volume is mounted, relative to the source root, so it is never
# copied into itself. Empty when the volume is outside the source root.
# ${SRC_ROOT%/} is empty when the source is "/", in which case the pattern is
# "/*" (not "//*", which would match nothing and silently disable the check).
DEST_REL=""
SRC_PREFIX="${SRC_ROOT%/}"
case "$DEST/" in
    "${SRC_PREFIX}"/*)
        DEST_REL="${DEST#"$SRC_PREFIX"}"
        DEST_REL="${DEST_REL#/}"
        ;;
esac

REL_LIST=""
for rel in $MOUNTS; do
    norm="$(normalize_rel "$rel")" \
        || die 2 "invalid directory in PERSIST_MOUNTS: '$rel'."
    case " $REL_LIST " in
        *" $norm "*)
            die 2 "duplicate directory in PERSIST_MOUNTS: '$norm'."
            ;;
    esac
    # Two entries that contain one another would mount the same subtree twice
    # (for example /var and /var/lib). The kubelet would honour both, with
    # confusing results, so reject them here.
    for existing in $REL_LIST; do
        case "$norm" in
            "$existing"/*)
                die 2 "'/$norm' is inside the already listed '/$existing'."
                ;;
        esac
        case "$existing" in
            "$norm"/*)
                die 2 "'/$existing' is inside the already listed '/$norm'."
                ;;
        esac
    done
    case "$norm" in
        proc|sys|dev)
            die 2 "'/$norm' is kernel/runtime state and cannot be persisted."
            ;;
        tmp|run)
            log "warning: '/$norm' is runtime state; persisting it usually"
            log "warning: brings back stale sockets and lock files."
            ;;
    esac
    if [ -n "$DEST_REL" ]; then
        case "$norm" in
            "$DEST_REL"|"$DEST_REL"/*)
                die 2 "'/$norm' overlaps the persistence volume at '$DEST'."
                ;;
        esac
        case "$DEST_REL" in
            "$norm"/*)
                die 2 "'/$norm' contains the persistence volume at '$DEST'."
                ;;
        esac
    fi
    [ -d "$SRC_ROOT/$norm" ] \
        || die 1 "the image has no directory '/$norm' (check PERSIST_MOUNTS)."
    [ ! -L "$SRC_ROOT/$norm" ] \
        || die 2 "'/$norm' is a symlink; persist its target directory instead."
    REL_LIST="${REL_LIST:+$REL_LIST }$norm"
done
[ -n "$REL_LIST" ] || die 2 "PERSIST_MOUNTS is empty."
log "persistent directories: ${REL_LIST// /, }"

STATE_DIR="$DEST/.clouddesktop-seed"
TMP_ROOT="$DEST/.clouddesktop-seed-tmp"
GLOBAL_MARKER="$DEST/.clouddesktop-seeded"

mkdir -p "$STATE_DIR" "$TMP_ROOT" \
    || die 1 "cannot create the seed bookkeeping in '$DEST'."
# Stale temporaries from a run that was killed before its rename.
rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT"

mark_done() {
    local rel="$1"
    local marker="$STATE_DIR/$rel.done"
    mkdir -p "$(dirname "$marker")"
    : > "$marker"
    chmod 0644 "$marker" 2>/dev/null || true
    if [ "$(id -u)" -eq 0 ]; then
        chown 0:0 "$marker" 2>/dev/null || true
    fi
}

# rm -rf on a mount point recurses into the mounted filesystem and deletes its
# contents. The seed only expects the volume itself at $DEST, but a stray mount
# (or a manual run against the wrong path) must never wipe somebody's data.
remove_target() {
    local target="$1"
    if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$target"; then
        die 1 "'$target' is a mount point; refusing to replace it."
    fi
    rm -rf "$target"
}

# Copy one directory into the volume. The copy goes to a temporary directory on
# the same filesystem and is renamed into place, so a kill can never leave a
# half-seeded directory that the main container would mount.
seed_dir() {
    local rel="$1"
    local src="$SRC_ROOT/$rel"
    local target="$DEST/$rel"
    local tmp="$TMP_ROOT/$rel"
    local marker="$STATE_DIR/$rel.done"

    [ -d "$src" ] || die 1 "source directory '$src' disappeared."
    [ ! -L "$src" ] || die 2 "'$src' is a symlink."

    # A target that survived from an earlier seed, with its marker lost, is
    # user data: adopt it instead of replacing it with the image's copy.
    # `find -print -quit` stops at the first entry, so this stays O(1) even
    # for a directory with hundreds of thousands of files.
    if [ "$FORCE" != "1" ] && [ -f "$GLOBAL_MARKER" ] && [ -d "$target" ] \
            && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit \
                       2>/dev/null)" ]; then
        log "adopting existing '/$rel' (its seed marker was missing)."
        mark_done "$rel"
        return 0
    fi

    # --force is explicitly destructive, so drop the old copy first and avoid
    # holding two copies on the volume at once.
    if [ "$FORCE" = "1" ] && [ -e "$target" ]; then
        remove_target "$target" || die 1 "cannot clear '$target'."
    fi

    log "seeding '/$rel' into '$target' (one time)..."
    rm -rf "$tmp"
    mkdir -p "$tmp"

    # xattrs carry file capabilities (e.g. ping); ACLs carry permissions some
    # images rely on. Both are optional: some CSI filesystems reject them, in
    # which case the plain copy below still produces a bootable tree.
    if ! tar -C "$src" --one-file-system --sparse --xattrs --acls \
             --numeric-owner -cf - . \
         | tar -C "$tmp" --sparse --xattrs --acls --numeric-owner -xpf -; then
        log "warning: xattrs/ACLs could not be preserved on '$DEST';"
        log "warning: retrying '/$rel' without them."
        rm -rf "$tmp"
        mkdir -p "$tmp"
        if ! tar -C "$src" --one-file-system --sparse --numeric-owner -cf - . \
             | tar -C "$tmp" --sparse --numeric-owner -xpf -; then
            die 1 "could not copy '/$rel' into '$DEST' (is the volume full?)."
        fi
    fi

    mkdir -p "$(dirname "$target")"
    remove_target "$target"
    mv -T "$tmp" "$target" || die 1 "cannot move the seeded '/$rel' into place."
    mark_done "$rel"
    log "seeded '/$rel'."
}

# kubelet writes /etc/hosts, /etc/hostname and /etc/resolv.conf as bind mounts
# over the image's files. Depending on mount order, the main container may see
# the persistent /etc instead of those live files, so refresh the copies on
# every pod start. They are tiny and identical for the init and main container
# of the same pod.
refresh_runtime_files() {
    local f tmp
    [ -d "$DEST/etc" ] || return 0
    for f in hosts hostname resolv.conf; do
        [ -e "$SRC_ROOT/etc/$f" ] || continue
        tmp="$DEST/etc/.clouddesktop-$f.$$"
        if cat "$SRC_ROOT/etc/$f" > "$tmp" 2>/dev/null; then
            chmod 0644 "$tmp" 2>/dev/null || true
            if [ "$(id -u)" -eq 0 ]; then
                chown 0:0 "$tmp" 2>/dev/null || true
            fi
            mv -fT "$tmp" "$DEST/etc/$f" 2>/dev/null \
                || { rm -f "$tmp"; log "warning: cannot update '/etc/$f'."; }
        else
            rm -f "$tmp"
            log "warning: cannot read '$SRC_ROOT/etc/$f'."
        fi
    done
}

# The adopted root is the old image, but the entrypoint that has to understand
# PERSIST_MODE=direct lives there too. Refresh just that helper from this
# image, so switching an older full-mode volume to direct works without
# re-seeding the whole root.
refresh_persist_helper() {
    local src="$SRC_ROOT/usr/local/bin/persist-entry"
    local dst="$DEST/usr/local/bin/persist-entry"
    local tmp="$dst.new.$$"

    [ -d "$DEST/usr" ] || return 0
    [ -f "$src" ] || return 0
    mkdir -p "$(dirname "$dst")" 2>/dev/null || return 0
    if cp -f "$src" "$tmp" 2>/dev/null; then
        chmod 0755 "$tmp" 2>/dev/null || true
        if [ "$(id -u)" -eq 0 ]; then
            chown 0:0 "$tmp" 2>/dev/null || true
        fi
        if mv -fT "$tmp" "$dst" 2>/dev/null; then
            log "refreshed the persistent persistence entrypoint from this image."
        else
            rm -f "$tmp"
            log "warning: could not refresh '$dst'."
        fi
    else
        rm -f "$tmp"
        log "warning: could not read '$src'."
    fi
}

# A PERSIST_MODE=full volume is already a copy of the whole root, with the same
# <volume>/<dir> layout. Adopt it in place; re-seeding would replace the user's
# files with the image's.
adopt_full_seed() {
    local rel
    log "found a full-mode seed ('$DEST/.seeded'); adopting it in place."
    for rel in $REL_LIST; do
        [ -f "$STATE_DIR/$rel.done" ] && continue
        if [ ! -d "$DEST/$rel" ]; then
            case "$rel" in
                etc|home|root|usr|var)
                    die 1 "the full-mode seed at '$DEST' has no '/$rel' directory;" \
                        "it looks incomplete. Remove '$DEST/.seeded' to re-seed," \
                        "or point PERSIST_DIR at a different volume."
                    ;;
                *)
                    log "warning: the full-mode seed has no '/$rel'; creating it empty."
                    mkdir -p "$DEST/$rel"
                    ;;
            esac
        fi
        mark_done "$rel"
    done
    refresh_persist_helper
}

write_global_marker() {
    local tmp="$GLOBAL_MARKER.$$"
    {
        echo "version=1"
        echo "mode=direct"
        echo "seeded=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        echo "mounts=$REL_LIST"
    } > "$tmp" || die 1 "cannot write '$GLOBAL_MARKER'."
    chmod 0644 "$tmp" 2>/dev/null || true
    if [ "$(id -u)" -eq 0 ]; then
        chown 0:0 "$tmp" 2>/dev/null || true
    fi
    mv -fT "$tmp" "$GLOBAL_MARKER" || die 1 "cannot publish '$GLOBAL_MARKER'."
}

if [ "$FORCE" = "1" ]; then
    log "PERSIST_SEED_FORCE=1: re-seeding every directory from the image."
fi

if [ "$FORCE" != "1" ] && [ -f "$DEST/.seeded" ]; then
    adopt_full_seed
else
    for rel in $REL_LIST; do
        marker="$STATE_DIR/$rel.done"
        if [ -f "$marker" ] && [ "$FORCE" != "1" ]; then
            continue
        fi
        seed_dir "$rel"
    done
fi

refresh_runtime_files
write_global_marker

log "done: ${REL_LIST// /, } seeded at '$DEST'."

#!/usr/bin/env python3
# ============================================================================
#  Delta persistence for the CloudDesktop images.
#
#  PERSIST_MODE=delta keeps a shadow copy of everything that changed on the
#  container's filesystem in $PERSIST_DIR/.clouddesktop-delta and copies it back
#  over a fresh container at startup. Only changed files are stored, and it
#  needs no mount(2), pivot_root(2) or extra capability -- just uid 0 so it can
#  read and write the whole root filesystem.
#
#  The image bakes a baseline index of its own filesystem
#  (/usr/local/share/clouddesktop/delta-baseline.json.gz, written by the
#  `baseline` subcommand at build time). A path is part of the delta when it is
#  new, or its type/size/mtime/mode/owner differs from the baseline, or it was
#  already stored in the shadow. Deleting a baseline path records a tombstone.
#
#  Subcommands:
#    baseline --output FILE   write the image baseline index (build time)
#    restore  --store DIR     apply the shadow and tombstones to the root
#    sync     --store DIR     store the current delta in the shadow
#    loop     --store DIR     sync now and then every --interval seconds
#    status   --store DIR     print the last sync summary
#
#  Everything is deliberately filesystem-only: no database, no background
#  daemon of its own beyond the sync loop the entrypoint starts. Paths are
#  handled as bytes-safe str (Python's surrogateescape), so names with spaces,
#  newlines or non-UTF-8 bytes round-trip correctly.
# ============================================================================
from __future__ import annotations

import argparse
import fcntl
import fnmatch
import gzip
import json
import logging
import os
import re
import shutil
import signal
import stat
import sys
import tempfile
import time
from contextlib import contextmanager

LOG = logging.getLogger("delta-persist")

STORE_VERSION = 1
STORE_DIRNAME = ".clouddesktop-delta"
DEFAULT_BASELINE = "/usr/local/share/clouddesktop/delta-baseline.json.gz"

# Private prefix for the temporary files used while copying. A restore killed
# mid-write can leave one behind; the scanner ignores them so they never become
# part of the stored delta.
TMP_PREFIX = ".clouddesktop-delta-tmp-"

# Paths that must never be captured: kernel/pod runtime state, tmpfs, mounts
# kubelet owns, package-manager locks (restoring a stale lock wedges apt) and
# caches that are rebuilt rather than saved. Everything is relative to /.
DEFAULT_EXCLUDES = (
    "proc",
    "sys",
    "dev",
    "run",
    "tmp",
    "var/run",
    "var/tmp",
    "var/cache",
    "var/log",
    "mnt",
    "media",
    "lost+found",
    "etc/hosts",
    "etc/hostname",
    "etc/resolv.conf",
    "var/lib/dpkg/lock",
    "var/lib/dpkg/lock-frontend",
    "var/lib/apt/lists/lock",
)

# Fingerprint tuple positions.
F_TYPE, F_SIZE, F_MTIME, F_MODE, F_UID, F_GID, F_LINK = range(7)


# ── Small path helpers ──────────────────────────────────────────────────────


def _norm_rel(path: str) -> str:
    """Normalise an absolute or relative path to a clean relative path."""
    path = path.replace(os.sep, "/").strip("/")
    if path in ("", "."):
        return ""
    return path


def _rel_under(root: str, path: str) -> str:
    """Return `path` relative to `root` if it is inside it, else ''."""
    try:
        rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
    except ValueError:  # different drives, cannot happen on Linux
        return ""
    if rel == "." or rel.startswith(".."):
        return ""
    return _norm_rel(rel)


def _safe_path(root: str, rel: str) -> str:
    """Join a stored relative path to root, rejecting traversal."""
    rel = _norm_rel(rel)
    if not rel:
        raise ValueError("refusing to address the root itself")
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("unsafe relative path: %r" % rel)
    return os.path.join(root, *parts)


def _depth(rel: str) -> int:
    return rel.count("/")


def _under_any(rel: str, prefixes) -> bool:
    return any(rel == p or rel.startswith(p + "/") for p in prefixes)


def _on_other_mount(root: str, path: str) -> bool:
    """True if path lands on (or below) a mount other than the root filesystem.

    Delta mode only owns the container root. Restoring over a volume or a
    configMap mount would write into somebody else's filesystem, and deleting
    a tombstoned path there would be worse, so such paths are left alone.
    """
    root = os.path.abspath(root)
    root_dev = os.lstat(root).st_dev
    root_prefix = root if root.endswith(os.sep) else root + os.sep
    probe = os.path.abspath(path)
    while True:
        if os.path.lexists(probe):
            if probe == root:
                return False
            if os.path.ismount(probe):
                return True
            return os.lstat(probe).st_dev != root_dev
        parent = os.path.dirname(probe)
        if parent == probe or not parent.startswith(root_prefix):
            return False
        probe = parent


# ── Exclusion rules ─────────────────────────────────────────────────────────


class Excluder:
    """Filter for paths that are not part of the persistent delta.

    `extra` accepts whitespace/comma-separated relative paths; entries with a
    glob character are matched with fnmatch (and also match their children),
    plain entries exclude that path and everything below it.
    """

    def __init__(self, root: str, store: str, baseline: str | None = None,
                 extra: str = ""):
        self.root = os.path.abspath(root)
        self.prefixes: set[str] = set()
        self.patterns: list[str] = []

        for entry in DEFAULT_EXCLUDES:
            self._add(entry)
        for entry in re.split(r"[\s,]+", extra or ""):
            if entry.strip():
                self._add(entry)
        for candidate in (store, baseline):
            if candidate:
                rel = _rel_under(self.root, candidate)
                if rel:
                    self.prefixes.add(rel)

    def _add(self, entry: str) -> None:
        entry = _norm_rel(entry)
        if not entry:
            return
        if any(ch in entry for ch in "*?["):
            self.patterns.append(entry)
        else:
            self.prefixes.add(entry)

    def excluded(self, rel: str) -> bool:
        rel = _norm_rel(rel)
        if not rel:
            return False
        for prefix in self.prefixes:
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
        for pattern in self.patterns:
            if fnmatch.fnmatchcase(rel, pattern):
                return True
            if fnmatch.fnmatchcase(rel, pattern.rstrip("/") + "/*"):
                return True
        return False

    __call__ = excluded


# ── Filesystem walking and fingerprints ─────────────────────────────────────


def walk(root: str, excluder: Excluder | None = None,
         skipped: list[str] | None = None):
    """Yield (relative_path, absolute_path, lstat) for the root's own files.

    - never follows symlinks;
    - skips entries on a different device than root (the PVC, tmpfs, kubelet's
      bind-mounted /etc/hosts, ...), recording the relative path in `skipped`
      so deletions below such a mount are not mistaken for user deletions;
    - skips directories that cannot be read and records them as skipped;
    - only yields regular files, directories and symlinks.
    """
    root = os.path.abspath(root)
    root_dev = os.stat(root).st_dev
    if skipped is None:
        skipped = []
    stack: list[tuple[str, str]] = [("", root)]
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            with os.scandir(abs_dir) as handle:
                entries = list(handle)
        except OSError as exc:
            if rel_dir:
                LOG.warning("cannot read %s: %s (not treating its children as deleted)",
                            abs_dir, exc.strerror or exc)
                skipped.append(rel_dir)
            continue

        for entry in entries:
            # Leftovers from a restore that was SIGKILLed mid-copy. They are
            # ours, not user data, and must never enter the delta.
            if entry.name.startswith(TMP_PREFIX):
                continue
            rel = entry.name if not rel_dir else rel_dir + "/" + entry.name
            if excluder is not None and excluder(rel):
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError as exc:
                LOG.warning("cannot stat %s: %s", entry.path, exc.strerror or exc)
                skipped.append(rel)
                continue

            if st.st_dev != root_dev:
                # A mount point: its contents belong to another filesystem, not
                # to the container root we are persisting.
                skipped.append(rel)
                continue

            if stat.S_ISDIR(st.st_mode):
                yield rel, entry.path, st
                stack.append((rel, entry.path))
            elif stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
                yield rel, entry.path, st
            # Sockets, FIFOs and device nodes are runtime-only; do not persist.


def fingerprint(st: os.stat_result, link: str | None = None) -> list:
    """Metadata fingerprint used to decide whether a path has changed.

    Timestamps are compared with one-second precision: image extraction and
    some storage layers do not preserve nanoseconds, and a false negative on
    the nanosecond field would re-store every image file on the first sync.
    """
    if stat.S_ISDIR(st.st_mode):
        kind, size = "d", 0
    elif stat.S_ISLNK(st.st_mode):
        kind, size = "l", 0
    else:
        kind, size = "f", st.st_size
    return [
        kind,
        size,
        st.st_mtime_ns // 1_000_000_000,
        stat.S_IMODE(st.st_mode),
        st.st_uid,
        st.st_gid,
        link,
    ]


def fingerprint_of(rel: str, abspath: str, st: os.stat_result) -> list:
    link = None
    if stat.S_ISLNK(st.st_mode):
        try:
            link = os.readlink(abspath)
        except OSError:
            link = None
    return fingerprint(st, link)


def dir_meta(st: os.stat_result) -> list:
    return [stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid, st.st_mtime_ns]


def _same(left: list, right: list) -> bool:
    if left is None or right is None:
        return False
    return (left[F_TYPE] == right[F_TYPE]
            and left[F_SIZE] == right[F_SIZE]
            and left[F_MTIME] == right[F_MTIME]
            and left[F_MODE] == right[F_MODE]
            and left[F_UID] == right[F_UID]
            and left[F_GID] == right[F_GID]
            and left[F_LINK] == right[F_LINK])


# ── JSON/state files ────────────────────────────────────────────────────────


def _atomic_write(path: str, writer) -> None:
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".",
                               dir=parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            writer(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        # Make the rename itself durable; a store index that silently rolls
        # back after a node crash could resurrect deleted files.
        try:
            dir_fd = os.open(parent, os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_json(path: str, value) -> None:
    def writer(handle):
        data = json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                          sort_keys=True).encode("utf-8")
        handle.write(data)

    _atomic_write(path, writer)


def _write_json_gz(path: str, value) -> None:
    def writer(handle):
        with gzip.GzipFile(fileobj=handle, mode="wb", mtime=0) as gz:
            data = json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                              sort_keys=True).encode("utf-8")
            gz.write(data)

    _atomic_write(path, writer)


def _read_json(path: str, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        raise RuntimeError("cannot read %s: %s" % (path, exc)) from exc


def _read_json_gz(path: str):
    if not os.path.isfile(path):
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        raise RuntimeError("cannot read %s: %s" % (path, exc)) from exc


# ── Store layout and lock ───────────────────────────────────────────────────


class Store:
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.shadow = os.path.join(self.path, "root")
        self.dirs_file = os.path.join(self.path, "dirs.json")
        self.tombstones_file = os.path.join(self.path, "tombstones.json")
        self.status_file = os.path.join(self.path, "status.json")
        self.version_file = os.path.join(self.path, "version")
        self.lock_file = os.path.join(self.path, "lock")
        self.baseline_file = os.path.join(self.path, "baseline.json.gz")

    def ensure(self) -> None:
        os.makedirs(self.path, mode=0o700, exist_ok=True)
        try:
            os.chmod(self.path, 0o700)
        except OSError:
            pass

        version = ""
        try:
            with open(self.version_file, "r", encoding="utf-8") as handle:
                version = handle.read().strip()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise RuntimeError("cannot read %s: %s" % (self.version_file, exc))

        if version and version != str(STORE_VERSION):
            raise RuntimeError(
                "store %s has format version %r, this image understands %d; "
                "move it aside or use PERSIST_MODE=full"
                % (self.path, version, STORE_VERSION))

        if not version:
            _atomic_write(self.version_file,
                          lambda handle: handle.write(str(STORE_VERSION).encode()))

        os.makedirs(self.shadow, mode=0o700, exist_ok=True)

    @contextmanager
    def lock(self):
        self.ensure()
        fd = os.open(self.lock_file, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def load_dirs(self) -> dict[str, list]:
        data = _read_json(self.dirs_file, {})
        if not isinstance(data, dict):
            raise RuntimeError("%s is not a JSON object" % self.dirs_file)
        return data

    def load_tombstones(self) -> set[str]:
        data = _read_json(self.tombstones_file, [])
        if not isinstance(data, list):
            raise RuntimeError("%s is not a JSON list" % self.tombstones_file)
        return {_norm_rel(item) for item in data
                if isinstance(item, str) and _norm_rel(item)}

    def save_dirs(self, dirs: dict[str, list]) -> None:
        _write_json(self.dirs_file, dirs)

    def save_tombstones(self, tombstones: set[str]) -> None:
        _write_json(self.tombstones_file, sorted(tombstones))

    def write_status(self, **fields) -> None:
        fields.setdefault("lastRun", time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                   time.gmtime()))
        try:
            _write_json(self.status_file, fields)
        except OSError as exc:
            LOG.warning("cannot write %s: %s", self.status_file, exc)


# ── Baseline ────────────────────────────────────────────────────────────────


def build_baseline(root: str, excluder: Excluder) -> dict[str, list]:
    files: dict[str, list] = {}
    skipped: list[str] = []
    errors = 0
    for rel, abspath, st in walk(root, excluder, skipped):
        try:
            files[rel] = fingerprint_of(rel, abspath, st)
        except OSError as exc:
            errors += 1
            LOG.warning("baseline: cannot fingerprint %s: %s", abspath, exc)
    if errors:
        LOG.warning("baseline: %d path(s) could not be fingerprinted", errors)
    return files


def write_baseline(path: str, files: dict[str, list]) -> None:
    _write_json_gz(path, {"version": STORE_VERSION, "files": files})


def load_baseline_file(path: str) -> dict[str, list] | None:
    data = _read_json_gz(path)
    if data is None:
        return None
    if not isinstance(data, dict) or data.get("version") != STORE_VERSION:
        raise RuntimeError(
            "%s is not a version-%d delta baseline; rebuild the image or pass "
            "--baseline" % (path, STORE_VERSION))
    files = data.get("files")
    if not isinstance(files, dict):
        raise RuntimeError("%s has no files index" % path)
    return files


def resolve_baseline(store: Store, root: str, excluder: Excluder,
                     explicit: str | None,
                     allow_create: bool = True) -> dict[str, list]:
    """Load the image baseline, generating a fallback one if none was baked.

    The fallback is written to the store *before* a restore, while the
    container root is still the pristine image. It keeps delta mode usable on
    images built before the baseline step existed, at the cost of not noticing
    an image upgrade automatically; the baked baseline is always preferred.
    """
    candidates: list[str] = []
    if explicit:
        candidates.append(os.path.abspath(explicit))
    else:
        candidates.append(DEFAULT_BASELINE)

    for candidate in candidates:
        if os.path.isfile(candidate):
            files = load_baseline_file(candidate)
            if files is not None:
                LOG.debug("using image baseline %s (%d paths)",
                          candidate, len(files))
                return files

    if os.path.isfile(store.baseline_file):
        files = load_baseline_file(store.baseline_file)
        if files is not None:
            LOG.debug("using fallback baseline %s (%d paths)",
                      store.baseline_file, len(files))
            return files

    if explicit:
        raise RuntimeError("baseline %s does not exist" % explicit)

    if not allow_create:
        raise RuntimeError(
            "no image baseline found (looked for %s and %s); run the restore "
            "step first" % (DEFAULT_BASELINE, store.baseline_file))

    LOG.warning("no image baseline found at %s; creating one in the store from "
                "the current (pristine) root filesystem", DEFAULT_BASELINE)
    files = build_baseline(root, excluder)
    write_baseline(store.baseline_file, files)
    return files


# ── Copy helpers ────────────────────────────────────────────────────────────


def _copy_xattrs(src: str, dst: str) -> None:
    try:
        names = os.listxattr(src, follow_symlinks=False)
    except OSError:
        return
    for name in names:
        try:
            value = os.getxattr(src, name, follow_symlinks=False)
            os.setxattr(dst, name, value, follow_symlinks=False)
        except OSError as exc:
            LOG.debug("cannot copy xattr %s from %s: %s", name, src, exc)


def _remove_path(path: str) -> bool:
    """Remove a file/symlink/directory tree; return False if it could not."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError as exc:
        LOG.warning("cannot inspect %s: %s", path, exc)
        return False
    try:
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(path)
        else:
            os.unlink(path)
    except FileNotFoundError:
        return True
    except OSError as exc:
        LOG.warning("cannot remove %s: %s", path, exc)
        return False
    return True


def _ensure_parent(path: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def copy_regular(src: str, dst: str, st: os.stat_result) -> None:
    """Copy file contents + ownership/mode/times/xattrs, atomically."""
    _ensure_parent(dst)
    if os.path.isdir(dst) and not os.path.islink(dst):
        shutil.rmtree(dst)
    fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX,
                               dir=os.path.dirname(dst))
    try:
        with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
            shutil.copyfileobj(inp, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
            try:
                os.fchown(out.fileno(), st.st_uid, st.st_gid)
            except OSError as exc:
                LOG.warning("cannot set owner %d:%d on %s: %s",
                            st.st_uid, st.st_gid, dst, exc)
            try:
                os.fchmod(out.fileno(), stat.S_IMODE(st.st_mode))
            except OSError as exc:
                LOG.warning("cannot set mode on %s: %s", dst, exc)
        _copy_xattrs(src, tmp)
        try:
            os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        except OSError as exc:
            LOG.warning("cannot set times on %s: %s", dst, exc)
        os.replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def copy_symlink(src: str, dst: str, st: os.stat_result) -> None:
    target = os.readlink(src)
    _ensure_parent(dst)
    if os.path.isdir(dst) and not os.path.islink(dst):
        shutil.rmtree(dst)
    tmp = os.path.join(os.path.dirname(dst),
                       TMP_PREFIX + "link.%d" % os.getpid())
    try:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        os.symlink(target, tmp)
        try:
            os.lchown(tmp, st.st_uid, st.st_gid)
        except OSError as exc:
            LOG.warning("cannot set owner on symlink %s: %s", dst, exc)
        try:
            os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns),
                     follow_symlinks=False)
        except OSError:
            pass
        _copy_xattrs(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_dir(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        return
    _remove_path(path)
    os.makedirs(path, mode=0o700, exist_ok=True)


def apply_metadata(path: str, mode: int, uid: int, gid: int,
                   mtime_ns: int) -> None:
    try:
        os.chown(path, uid, gid)
    except OSError as exc:
        LOG.warning("cannot set owner %d:%d on %s: %s", uid, gid, path, exc)
    try:
        os.chmod(path, mode)
    except OSError as exc:
        LOG.warning("cannot set mode on %s: %s", path, exc)
    try:
        os.utime(path, ns=(mtime_ns, mtime_ns))
    except OSError as exc:
        LOG.warning("cannot set times on %s: %s", path, exc)


# ── Store/restore of one path ───────────────────────────────────────────────


def save_entry(store: Store, rel: str, abspath: str, st: os.stat_result,
               dirs: dict[str, list]) -> None:
    """Save one current path into the shadow tree."""
    dest = _safe_path(store.shadow, rel)
    if stat.S_ISDIR(st.st_mode):
        ensure_dir(dest)
        dirs[rel] = dir_meta(st)
    elif stat.S_ISLNK(st.st_mode):
        copy_symlink(abspath, dest, st)
        dirs.pop(rel, None)
    else:
        copy_regular(abspath, dest, st)
        dirs.pop(rel, None)
    LOG.info("saved %s", rel)


def record_ancestors(root: str, rel: str, dirs: dict[str, list]) -> None:
    """Remember the metadata of every directory above a saved path.

    Without this, a file saved under an unchanged image directory would be
    restored later with a bare `makedirs` if an image upgrade had removed that
    directory, leaving it owned by root with a default mode. Recording the
    ancestors is cheap (a handful of entries) and makes the restored tree
    identical to the one that was captured.
    """
    parts = rel.split("/")
    for index in range(1, len(parts)):
        ancestor = "/".join(parts[:index])
        if ancestor in dirs:
            continue
        try:
            st = os.lstat(os.path.join(root, ancestor))
        except OSError:
            continue
        if stat.S_ISDIR(st.st_mode):
            dirs[ancestor] = dir_meta(st)


def _discard_tombstones(tombstones: set[str], rel: str) -> None:
    """A re-created path (and its ancestors) is no longer deleted."""
    tombstones.discard(rel)
    parts = rel.split("/")
    for index in range(1, len(parts)):
        tombstones.discard("/".join(parts[:index]))


# ── Sync ────────────────────────────────────────────────────────────────────


def run_sync(root: str, store: Store, baseline_path: str | None,
             excluder: Excluder) -> dict:
    started = time.monotonic()
    with store.lock():
        LOG.info("saving filesystem state to %s", store.path)
        baseline = resolve_baseline(store, root, excluder, baseline_path,
                                    allow_create=False)
        dirs = store.load_dirs()
        tombstones = store.load_tombstones()

        shadow_files: dict[str, list] = {}
        shadow_dirs: set[str] = set()
        for rel, abspath, st in walk(store.shadow):
            if stat.S_ISDIR(st.st_mode):
                shadow_dirs.add(rel)
            else:
                try:
                    shadow_files[rel] = fingerprint_of(rel, abspath, st)
                except OSError:
                    pass

        seen: set[str] = set()
        skipped: list[str] = []
        saved = removed = 0

        for rel, abspath, st in walk(root, excluder, skipped):
            seen.add(rel)
            # A tombstoned path can only be present here if something re-created
            # it after restore deleted it (the restore runs before this loop),
            # so its deletion has been undone. This also covers re-creating a
            # file with exactly the image's original content.
            _discard_tombstones(tombstones, rel)
            try:
                if stat.S_ISDIR(st.st_mode):
                    persisted = rel in dirs
                    if persisted and dirs[rel] == dir_meta(st):
                        continue
                    if not persisted:
                        base = baseline.get(rel)
                        if base is not None and _same(base, fingerprint(st)):
                            continue
                    save_entry(store, rel, abspath, st, dirs)
                    record_ancestors(root, rel, dirs)
                    shadow_files.pop(rel, None)
                else:
                    current = fingerprint_of(rel, abspath, st)
                    if rel in shadow_files:
                        if _same(shadow_files[rel], current):
                            continue
                    else:
                        base = baseline.get(rel)
                        if base is not None and _same(base, current):
                            continue
                    save_entry(store, rel, abspath, st, dirs)
                    record_ancestors(root, rel, dirs)
                    shadow_files[rel] = current
                    shadow_dirs.discard(rel)
            except OSError as exc:
                LOG.warning("cannot persist %s: %s", abspath, exc)
                continue

            saved += 1

        # Paths that used to be in the shadow are gone from the root: remember
        # the deletion so a later restore does not bring them back.
        for rel in sorted(shadow_files):
            if rel in seen or excluder(rel) or _under_any(rel, skipped):
                continue
            _remove_path(_safe_path(store.shadow, rel))
            shadow_files.pop(rel, None)
            dirs.pop(rel, None)
            tombstones.add(rel)
            removed += 1

        for rel in sorted(shadow_dirs, key=_depth, reverse=True):
            if rel in seen or excluder(rel) or _under_any(rel, skipped):
                continue
            path = _safe_path(store.shadow, rel)
            if os.path.isdir(path):
                try:
                    os.rmdir(path)  # only empty ones; populated dirs have entries
                except OSError:
                    pass
            shadow_dirs.discard(rel)

        for rel in sorted(dirs, key=_depth, reverse=True):
            if rel in seen or excluder(rel) or _under_any(rel, skipped):
                continue
            _remove_path(_safe_path(store.shadow, rel))
            dirs.pop(rel, None)
            tombstones.add(rel)
            removed += 1

        # Baseline paths missing from the root are deletions of image files
        # that were never modified: full-root persistence restores those too.
        for rel in baseline:
            if rel in seen or excluder(rel) or _under_any(rel, skipped):
                continue
            tombstones.add(rel)

        store.save_dirs(dirs)
        store.save_tombstones(tombstones)

        summary = {
            "action": "sync",
            "root": root,
            "store": store.path,
            "entries": len(seen),
            "saved": saved,
            "removed": removed,
            "tombstones": len(tombstones),
            "durationMs": int((time.monotonic() - started) * 1000),
        }
        store.write_status(**summary)
        LOG.info("sync: %d path(s) scanned, %d saved, %d removed, %d tombstone(s) "
                 "in %d ms", len(seen), saved, removed, len(tombstones),
                 summary["durationMs"])
        return summary


# ── Restore ─────────────────────────────────────────────────────────────────


def run_restore(root: str, store: Store, baseline_path: str | None,
                excluder: Excluder) -> dict:
    started = time.monotonic()
    with store.lock():
        # Ensure a baseline exists before touching the root: a fallback
        # baseline has to describe the pristine image, not the restored state.
        resolve_baseline(store, root, excluder, baseline_path)

        dirs = store.load_dirs()
        tombstones = store.load_tombstones()

        deleted = restored = failed = 0
        for rel in sorted(tombstones, key=_depth):
            if excluder(rel):
                LOG.debug("ignoring tombstone for excluded path %s", rel)
                continue
            try:
                path = _safe_path(root, rel)
            except ValueError as exc:
                LOG.warning("ignoring invalid tombstone %r: %s", rel, exc)
                continue
            if os.path.lexists(path):
                if _on_other_mount(root, path):
                    LOG.debug("not deleting %s: it is on another mount", path)
                    continue
                if _remove_path(path):
                    deleted += 1
                else:
                    failed += 1

        entries = list(walk(store.shadow))

        # Directories first, so an empty persisted directory exists even if no
        # file lives below it.
        for rel, abspath, st in sorted(
                (item for item in entries if stat.S_ISDIR(item[2].st_mode)),
                key=lambda item: _depth(item[0])):
            if excluder(rel):
                continue
            dest = _safe_path(root, rel)
            if _on_other_mount(root, dest):
                LOG.warning("not restoring directory %s: it is on another mount", dest)
                continue
            try:
                ensure_dir(dest)
            except OSError as exc:
                LOG.warning("cannot create directory %s: %s", rel, exc)

        for rel, abspath, st in sorted(
                (item for item in entries if not stat.S_ISDIR(item[2].st_mode)),
                key=lambda item: _depth(item[0])):
            if excluder(rel):
                continue
            dest = _safe_path(root, rel)
            if _on_other_mount(root, dest):
                LOG.warning("not restoring %s: it is on another mount", dest)
                continue
            try:
                if stat.S_ISLNK(st.st_mode):
                    copy_symlink(abspath, dest, st)
                else:
                    copy_regular(abspath, dest, st)
                restored += 1
            except OSError as exc:
                failed += 1
                LOG.error("cannot restore %s: %s", dest, exc)

        # Directory metadata last, deepest first: creating children changes
        # their parents' mtime, so applying parent metadata earlier would be
        # immediately undone.
        for rel in sorted(dirs, key=_depth, reverse=True):
            if excluder(rel):
                continue
            try:
                path = _safe_path(root, rel)
            except ValueError:
                continue
            if not os.path.isdir(path) or os.path.islink(path):
                continue
            try:
                mode, uid, gid, mtime_ns = dirs[rel]
            except (TypeError, ValueError):
                LOG.warning("ignoring invalid directory metadata for %s", rel)
                continue
            apply_metadata(path, mode, uid, gid, mtime_ns)

        summary = {
            "action": "restore",
            "root": root,
            "store": store.path,
            "restored": restored,
            "deleted": deleted,
            "failed": failed,
            "durationMs": int((time.monotonic() - started) * 1000),
        }
        store.write_status(**summary)
        LOG.info("restore: %d file(s)/symlink(s), %d deletion(s), %d failure(s) "
                 "in %d ms", restored, deleted, failed, summary["durationMs"])
        if failed:
            raise RuntimeError(
                "restore failed for %d path(s); refusing to start with a partial "
                "filesystem state" % failed)
        return summary


# ── Sync loop ───────────────────────────────────────────────────────────────


def run_loop(root: str, store: Store, baseline_path: str | None,
             excluder: Excluder, interval: int) -> int:
    stop = {"value": False}

    def handler(signum, _frame):
        LOG.info("received signal %d, stopping after the current sync", signum)
        stop["value"] = True

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)

    while not stop["value"]:
        try:
            run_sync(root, store, baseline_path, excluder)
        except Exception as exc:  # keep the desktop running if the PVC hiccups
            LOG.error("periodic sync failed: %s", exc)
            store.write_status(action="sync", error=str(exc))

        if interval <= 0:
            while not stop["value"]:
                time.sleep(1)
        else:
            deadline = time.monotonic() + interval
            while not stop["value"]:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(remaining, 1.0))

    LOG.info("sync loop stopped")
    return 0


# ── CLI ─────────────────────────────────────────────────────────────────────


def _make_excluder(args, store: Store) -> Excluder:
    extra = args.exclude
    if extra is None:
        extra = os.environ.get("PERSIST_EXCLUDE", "")
    return Excluder(os.path.abspath(args.root), store.path,
                    os.path.abspath(args.baseline) if args.baseline else
                    DEFAULT_BASELINE, extra)


def _cmd_baseline(args) -> int:
    root = os.path.abspath(args.root)
    output = os.path.abspath(args.output)
    excluder = Excluder(root, os.path.join(root, STORE_DIRNAME), output,
                        args.exclude or "")
    files = build_baseline(root, excluder)
    write_baseline(output, files)
    try:
        os.chmod(output, 0o644)
    except OSError:
        pass
    LOG.info("baseline: %d path(s) written to %s", len(files), output)
    return 0


def _cmd_restore(args) -> int:
    store = Store(args.store)
    excluder = _make_excluder(args, store)
    run_restore(os.path.abspath(args.root), store, args.baseline, excluder)
    return 0


def _cmd_sync(args) -> int:
    store = Store(args.store)
    excluder = _make_excluder(args, store)
    run_sync(os.path.abspath(args.root), store, args.baseline, excluder)
    return 0


def _cmd_loop(args) -> int:
    store = Store(args.store)
    excluder = _make_excluder(args, store)
    return run_loop(os.path.abspath(args.root), store, args.baseline, excluder,
                    args.interval)


def _cmd_status(args) -> int:
    store = Store(args.store)
    status = _read_json(store.status_file, None)
    if status is None:
        print("no sync has run yet in %s" % store.path)
        return 1
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0


def _parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="delta-persist",
        description="Delta-mode persistence for CloudDesktop images.")
    parser.add_argument("--root", default="/",
                        help="filesystem root to persist (default: /)")
    parser.add_argument("--baseline", default=None,
                        help="baseline index (default: %s)" % DEFAULT_BASELINE)
    parser.add_argument("--exclude", default=None,
                        help="extra excluded paths/globs, whitespace or comma "
                             "separated (default: $PERSIST_EXCLUDE)")
    parser.add_argument("-v", "--verbose", action="count", default=0)

    subparsers = parser.add_subparsers(dest="command", required=True)

    baseline = subparsers.add_parser("baseline",
                                     help="write the image baseline index")
    baseline.add_argument("--output", required=True)
    baseline.set_defaults(func=_cmd_baseline)

    for name, func, help_text in (
            ("restore", _cmd_restore, "apply the stored delta to the root"),
            ("sync", _cmd_sync, "store the current delta"),
            ("status", _cmd_status, "print the last sync summary")):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("--store", required=True)
        command.set_defaults(func=func)

    loop = subparsers.add_parser("loop", help="sync periodically")
    loop.add_argument("--store", required=True)
    loop.add_argument("--interval", type=int, default=300,
                      help="seconds between syncs (0 = only on shutdown)")
    loop.set_defaults(func=_cmd_loop)

    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)
    level = logging.INFO
    if args.verbose:
        level = logging.DEBUG
    logging.basicConfig(level=level,
                        format="delta-persist: %(levelname)s: %(message)s")
    try:
        return args.func(args)
    except (RuntimeError, OSError) as exc:
        LOG.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

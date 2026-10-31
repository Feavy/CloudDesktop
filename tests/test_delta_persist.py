#!/usr/bin/env python3
"""End-to-end tests for deploy/delta-persist.py.

Run with:

    python3 -m unittest discover -s tests -v

The tests use --root and --baseline so they do not need to run as root and do
not touch the machine's real filesystem. The file modes and ownership they set
belong to the invoking user, which is all the helper needs for this exercise.
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(REPO, "deploy", "delta-persist.py")


def run_helper(*args, check=True, env=None):
    command = [sys.executable, HELPER, *args]
    result = subprocess.run(command, capture_output=True, text=True,
                            env=env, check=False)
    if check and result.returncode != 0:
        raise AssertionError(
            "helper failed (%d): %s\nstdout:\n%s\nstderr:\n%s"
            % (result.returncode, " ".join(command), result.stdout,
               result.stderr))
    return result


class DeltaPersistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="delta-persist-test.")
        self.image = os.path.join(self.tmp, "image")
        self.root = os.path.join(self.tmp, "root")
        self.store = os.path.join(self.tmp, "store")
        self.baseline = os.path.join(self.tmp, "baseline.json.gz")

        self._write(self.image, "etc/os-release", "PRETTY_NAME=Test\n", 0o644)
        self._write(self.image, "home/user/keep.txt", "keep\n", 0o640)
        self._write(self.image, "home/user/delete-me.txt", "delete\n", 0o644)
        self._write(self.image, "usr/bin/tool", "#!/bin/sh\necho tool\n", 0o755)
        self._write(self.image, "var/log/app.log", "log\n", 0o644)
        self._write(self.image, "tmp/scratch", "scratch\n", 0o644)
        self._write(self.image, "opt/removed/child.txt", "child\n", 0o644)
        os.makedirs(os.path.join(self.image, "opt/existing"))
        os.symlink("../etc/os-release", os.path.join(self.image, "home/user/oslink"))

        self._reset_root()
        run_helper("--root", self.root, "--baseline", self.baseline,
                   "baseline", "--output", self.baseline)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _write(root, rel, content, mode):
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(path, mode)

    def _reset_root(self):
        if os.path.exists(self.root):
            shutil.rmtree(self.root)
        shutil.copytree(self.image, self.root, symlinks=True)

    def _sync(self):
        return run_helper("--root", self.root, "--baseline", self.baseline,
                          "sync", "--store", self.store)

    def _restore(self):
        return run_helper("--root", self.root, "--baseline", self.baseline,
                          "restore", "--store", self.store)

    def _read(self, rel):
        with open(os.path.join(self.root, rel), encoding="utf-8") as handle:
            return handle.read()

    def _shadow(self):
        shadow = os.path.join(self.store, "root")
        found = []
        stack = [shadow]
        while stack:
            directory = stack.pop()
            with os.scandir(directory) as handle:
                for entry in handle:
                    rel = os.path.relpath(entry.path, shadow).replace(os.sep,
                                                                      "/")
                    found.append(rel)
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
        return found

    def _json(self, name):
        with open(os.path.join(self.store, name), encoding="utf-8") as handle:
            return json.load(handle)

    # ── tests ──────────────────────────────────────────────────────────────

    def test_baseline_excludes_volatile_paths(self):
        with gzip.open(self.baseline, "rt", encoding="utf-8") as handle:
            files = json.load(handle)["files"]
        self.assertIn("etc/os-release", files)
        self.assertIn("home/user/keep.txt", files)
        self.assertNotIn("var/log/app.log", files)
        self.assertNotIn("tmp/scratch", files)
        self.assertNotIn(".clouddesktop-delta", files)

    def test_sync_stores_only_the_delta(self):
        self._write(self.root, "home/user/keep.txt", "changed\n", 0o640)
        self._write(self.root, "home/user/new.txt", "new\n", 0o600)
        os.remove(os.path.join(self.root, "home/user/delete-me.txt"))
        os.chmod(os.path.join(self.root, "etc/os-release"), 0o600)
        os.makedirs(os.path.join(self.root, "opt/new/data"))
        self._write(self.root, "opt/new/data/x", "x\n", 0o644)
        os.symlink("../opt", os.path.join(self.root, "home/user/optlink"))
        # Volatile paths must be ignored even when they change.
        self._write(self.root, "var/log/app.log", "changed log\n", 0o644)
        self._write(self.root, "tmp/scratch", "changed tmp\n", 0o644)

        self._sync()

        shadow = set(self._shadow())
        self.assertIn("home/user/keep.txt", shadow)
        self.assertIn("home/user/new.txt", shadow)
        self.assertIn("home/user/optlink", shadow)
        self.assertIn("opt/new/data/x", shadow)
        self.assertIn("etc/os-release", shadow)
        self.assertNotIn("usr/bin/tool", shadow)       # untouched image file
        self.assertNotIn("var/log/app.log", shadow)    # excluded
        self.assertNotIn("tmp/scratch", shadow)        # excluded

        tombstones = self._json("tombstones.json")
        self.assertIn("home/user/delete-me.txt", tombstones)

    def test_restore_round_trip(self):
        self._write(self.root, "home/user/keep.txt", "changed\n", 0o640)
        self._write(self.root, "home/user/new.txt", "new\n", 0o600)
        os.remove(os.path.join(self.root, "home/user/delete-me.txt"))
        os.chmod(os.path.join(self.root, "etc/os-release"), 0o600)
        os.makedirs(os.path.join(self.root, "opt/new/data"))
        self._write(self.root, "opt/new/data/x", "x\n", 0o644)
        os.symlink("../opt", os.path.join(self.root, "home/user/optlink"))
        self._write(self.root, "var/log/app.log", "changed log\n", 0o644)
        self._write(self.root, "tmp/scratch", "changed tmp\n", 0o644)

        self._sync()
        self._reset_root()
        self._restore()

        self.assertEqual(self._read("home/user/keep.txt"), "changed\n")
        self.assertEqual(self._read("home/user/new.txt"), "new\n")
        self.assertFalse(os.path.exists(
            os.path.join(self.root, "home/user/delete-me.txt")))
        self.assertEqual(stat.S_IMODE(os.stat(
            os.path.join(self.root, "etc/os-release")).st_mode), 0o600)
        self.assertEqual(self._read("opt/new/data/x"), "x\n")
        self.assertEqual(os.readlink(
            os.path.join(self.root, "home/user/optlink")), "../opt")
        # Restored symlink from the image is untouched.
        self.assertEqual(os.readlink(
            os.path.join(self.root, "home/user/oslink")), "../etc/os-release")
        # Volatile paths were never stored, so the fresh image values remain.
        self.assertEqual(self._read("var/log/app.log"), "log\n")
        self.assertEqual(self._read("tmp/scratch"), "scratch\n")

    def test_second_sync_after_restore_is_idempotent(self):
        self._write(self.root, "home/user/keep.txt", "changed\n", 0o640)
        self._write(self.root, "home/user/new.txt", "new\n", 0o600)
        self._sync()
        self._reset_root()
        self._restore()

        def snapshot():
            result = {}
            for rel in self._shadow():
                path = os.path.join(self.store, "root", rel)
                if os.path.isdir(path) and not os.path.islink(path):
                    continue
                if os.path.islink(path):
                    result[rel] = os.readlink(path)
                else:
                    with open(path, "rb") as handle:
                        result[rel] = handle.read()
            return result

        before = snapshot()
        self._sync()
        self.assertEqual(before, snapshot())

    def test_directory_deletion_and_empty_directory(self):
        shutil.rmtree(os.path.join(self.root, "opt/removed"))
        os.makedirs(os.path.join(self.root, "opt/empty/new"), mode=0o750)
        os.chmod(os.path.join(self.root, "opt/empty/new"), 0o750)

        self._sync()
        self.assertIn("opt/removed", self._json("tombstones.json"))
        self.assertIn("opt/removed/child.txt", self._json("tombstones.json"))

        self._reset_root()
        self._restore()
        self.assertFalse(os.path.exists(os.path.join(self.root, "opt/removed")))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "opt/empty/new")))
        self.assertEqual(stat.S_IMODE(os.stat(
            os.path.join(self.root, "opt/empty/new")).st_mode), 0o750)

    def test_non_utf8_and_newline_filename(self):
        name = b"weird-\xff-name\nwith-newline"
        home = os.path.join(os.fsencode(self.root), b"home/user")
        path = os.path.join(home, name)
        with open(path, "wb") as handle:
            handle.write(b"bytes\x00and\nnewlines\n")

        self._sync()
        self._reset_root()
        self._restore()

        restored = os.path.join(os.fsencode(self.root), b"home/user", name)
        self.assertTrue(os.path.exists(restored))
        with open(restored, "rb") as handle:
            self.assertEqual(handle.read(), b"bytes\x00and\nnewlines\n")

    def test_extra_exclude(self):
        self._write(self.root, "home/user/cache.bin", "cache\n", 0o644)
        self._write(self.root, "home/user/keep.txt", "changed\n", 0o640)
        run_helper("--root", self.root, "--baseline", self.baseline,
                   "--exclude", "home/user/*.bin", "sync", "--store", self.store)
        shadow = self._shadow()
        self.assertIn("home/user/keep.txt", shadow)
        self.assertNotIn("home/user/cache.bin", shadow)

    def test_fallback_baseline_is_created_and_used(self):
        # No --baseline: the helper has to create one in the store before it
        # restores, because the real image baseline is not available in a test.
        # That has to happen while the root is still pristine, hence restore
        # first, then make a change, then sync and restore again.
        run_helper("--root", self.root, "restore", "--store", self.store)
        self.assertTrue(os.path.isfile(os.path.join(self.store,
                                                    "baseline.json.gz")))

        self._write(self.root, "home/user/new.txt", "new\n", 0o600)
        run_helper("--root", self.root, "sync", "--store", self.store)

        self._reset_root()
        run_helper("--root", self.root, "restore", "--store", self.store)
        self.assertEqual(self._read("home/user/new.txt"), "new\n")

    def test_tombstone_is_cleared_when_path_is_recreated(self):
        os.remove(os.path.join(self.root, "home/user/delete-me.txt"))
        self._sync()
        self.assertIn("home/user/delete-me.txt", self._json("tombstones.json"))

        self._write(self.root, "home/user/delete-me.txt", "back\n", 0o644)
        self._sync()
        self.assertNotIn("home/user/delete-me.txt",
                         self._json("tombstones.json"))
        self.assertIn("home/user/delete-me.txt", self._shadow())

    def test_recreating_identical_baseline_file_clears_tombstone(self):
        os.remove(os.path.join(self.root, "home/user/delete-me.txt"))
        self._sync()
        self.assertIn("home/user/delete-me.txt", self._json("tombstones.json"))

        # Same bytes and mode as the image baseline.
        self._write(self.root, "home/user/delete-me.txt", "delete\n", 0o644)
        self._sync()
        self.assertNotIn("home/user/delete-me.txt",
                         self._json("tombstones.json"))

    def test_store_version_is_rejected_when_unknown(self):
        os.makedirs(self.store, exist_ok=True)
        with open(os.path.join(self.store, "version"), "w",
                  encoding="utf-8") as handle:
            handle.write("999\n")
        result = run_helper("--root", self.root, "--baseline", self.baseline,
                            "sync", "--store", self.store, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("format version", result.stderr)


if __name__ == "__main__":
    unittest.main()

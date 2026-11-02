#!/usr/bin/env python3
"""End-to-end tests for PERSIST_MODE=direct.

They cover the two pieces that make direct mode safe without capabilities:

  * deploy/seed-root.sh -- the initContainer that copies the image filesystem
    into the volume once, writes per-directory markers and adopts a volume
    previously seeded by PERSIST_MODE=full.
  * deploy/persist-entry.sh -- the main-container entrypoint that verifies the
    kubelet's subPath mounts and the markers before dropping to DESKTOP_USER.

No root, Kubernetes or real mounts are needed: the seed script accepts --root
and --persist, and the mount checks are pointed at filesystems that already
exist on the test machine (/dev/shm, /dev/pts, /etc).
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(REPO, "deploy", "seed-root.sh")
ENTRY = os.path.join(REPO, "deploy", "persist-entry.sh")
MANIFEST = os.path.join(REPO, "deploy", "kubernetes-desktop-direct.yaml")

MOUNTS = "etc home opt root srv usr var app"


def run(command, env=None, timeout=120):
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(command, capture_output=True, text=True,
                          env=full_env, timeout=timeout, check=False)


class SeedRootTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="direct-seed-test.")
        self.image = os.path.join(self.tmp, "image")
        self.store = os.path.join(self.tmp, "persist")
        self._write(self.image, "etc/os-release", "PRETTY_NAME=Test\n", 0o644)
        self._write(self.image, "etc/hosts", "10.0.0.1 host\n", 0o644)
        self._write(self.image, "etc/hostname", "pod-a\n", 0o644)
        self._write(self.image, "etc/resolv.conf", "nameserver 1.1.1.1\n",
                    0o644)
        self._write(self.image, "home/user/keep.txt", "keep\n", 0o640)
        self._write(self.image, "home/user/private.txt", "private\n", 0o600)
        self._write(self.image, "usr/bin/tool", "#!/bin/sh\necho tool\n",
                    0o755)
        self._write(self.image, "usr/local/bin/persist-entry",
                    "#!/bin/bash\n# direct-capable\n", 0o755)
        self._write(self.image, "var/lib/dpkg/status", "Status: ok\n", 0o644)
        self._write(self.image, "opt/existing/file", "opt\n", 0o644)
        self._write(self.image, "srv/data", "srv\n", 0o644)
        self._write(self.image, "root/.bashrc", "# root\n", 0o600)
        self._write(self.image, "app/server.js", "// app\n", 0o644)
        self._write(self.image, "tmp/scratch", "scratch\n", 0o644)
        self._write(self.image, "run/lock", "lock\n", 0o644)
        os.makedirs(os.path.join(self.image, "boot"))
        os.symlink("../etc/os-release",
                   os.path.join(self.image, "home/user/oslink"))

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

    def _seed(self, mounts=MOUNTS, store=None, env=None, check=True):
        result = run(["bash", SEED,
                      "--root", self.image,
                      "--persist", store or self.store,
                      "--mounts", mounts], env=env)
        if check and result.returncode != 0:
            raise AssertionError(
                "seed failed (%d)\nstdout:\n%s\nstderr:\n%s"
                % (result.returncode, result.stdout, result.stderr))
        return result

    def _path(self, rel, store=None):
        return os.path.join(store or self.store, rel)

    def _store_file(self, rel, store=None):
        with open(self._path(rel, store), encoding="utf-8") as handle:
            return handle.read()

    # ── seeding ────────────────────────────────────────────────────────────

    def test_seeds_only_the_persistent_directories(self):
        self._seed()

        self.assertEqual(self._store_file("etc/os-release"),
                         "PRETTY_NAME=Test\n")
        self.assertEqual(self._store_file("home/user/keep.txt"), "keep\n")
        self.assertEqual(self._store_file("usr/bin/tool"), "#!/bin/sh\necho tool\n")
        self.assertEqual(self._store_file("app/server.js"), "// app\n")
        # Ephemeral paths are not in PERSIST_MOUNTS, so they are not copied.
        self.assertFalse(os.path.exists(self._path("tmp")))
        self.assertFalse(os.path.exists(self._path("run")))

        # Permissions and symlinks survive the copy.
        self.assertEqual(stat.S_IMODE(os.stat(
            self._path("home/user/private.txt")).st_mode), 0o600)
        self.assertEqual(os.readlink(self._path("home/user/oslink")),
                         "../etc/os-release")

        # One marker per directory plus the global completion marker.
        for rel in MOUNTS.split():
            marker = self._path(".clouddesktop-seed/%s.done" % rel)
            self.assertTrue(os.path.isfile(marker), marker)
            self.assertEqual(stat.S_IMODE(os.stat(marker).st_mode), 0o644)
        self.assertTrue(os.path.isfile(self._path(".clouddesktop-seeded")))
        self.assertEqual(stat.S_IMODE(os.stat(
            self._path(".clouddesktop-seeded")).st_mode), 0o644)

    def test_second_run_keeps_user_data_and_refreshes_runtime_files(self):
        self._seed()
        with open(self._path("home/user/keep.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("changed by user\n")
        os.remove(self._path("home/user/private.txt"))
        self._write(self.image, "etc/hosts", "10.0.0.2 host\n", 0o644)

        self._seed()

        self.assertEqual(self._store_file("home/user/keep.txt"),
                         "changed by user\n")
        # A deletion made after the seed must not be undone by the next seed.
        self.assertFalse(os.path.exists(self._path("home/user/private.txt")))
        # kubelet's /etc files are refreshed on every pod start.
        self.assertEqual(self._store_file("etc/hosts"), "10.0.0.2 host\n")

    def test_new_directory_is_seeded_without_touching_the_others(self):
        self._seed()
        with open(self._path("home/user/keep.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("changed by user\n")
        self._write(self.image, "boot/vmlinuz", "kernel\n", 0o644)

        self._seed(mounts=MOUNTS + " boot")

        self.assertEqual(self._store_file("boot/vmlinuz"), "kernel\n")
        self.assertEqual(self._store_file("home/user/keep.txt"),
                         "changed by user\n")
        self.assertTrue(os.path.isfile(
            self._path(".clouddesktop-seed/boot.done")))

    def test_missing_marker_with_existing_data_adopts_instead_of_overwriting(self):
        self._seed()
        with open(self._path("home/user/keep.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("precious\n")
        os.remove(self._path(".clouddesktop-seed/home.done"))

        result = self._seed()

        self.assertIn("adopting existing '/home'", result.stderr)
        self.assertEqual(self._store_file("home/user/keep.txt"), "precious\n")
        self.assertTrue(os.path.isfile(
            self._path(".clouddesktop-seed/home.done")))

    def test_force_reseeds_from_the_image(self):
        self._seed()
        with open(self._path("home/user/keep.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("to be discarded\n")

        result = self._seed(env={"PERSIST_SEED_FORCE": "1"})

        self.assertIn("PERSIST_SEED_FORCE=1", result.stderr)
        self.assertEqual(self._store_file("home/user/keep.txt"), "keep\n")
        self.assertTrue(os.path.isfile(
            self._path(".clouddesktop-seed/home.done")))

    def test_mount_list_can_come_from_the_environment(self):
        result = run([ "bash", SEED, "--root", self.image,
                       "--persist", self.store],
                     env={"PERSIST_MOUNTS": "etc home"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.isdir(self._path("etc")))
        self.assertTrue(os.path.isdir(self._path("home")))
        self.assertFalse(os.path.exists(self._path("usr")))

    # ── full-mode adoption ─────────────────────────────────────────────────

    def test_adopts_a_full_mode_volume_in_place(self):
        full = os.path.join(self.tmp, "full")
        self._write(full, "etc/os-release", "PRETTY_NAME=Full\n", 0o644)
        self._write(full, "etc/hosts", "old\n", 0o644)
        self._write(full, "home/user/keep.txt", "full-mode data\n", 0o640)
        self._write(full, "usr/bin/tool", "tool\n", 0o755)
        self._write(full, "var/lib/dpkg/status", "status\n", 0o644)
        self._write(full, "root/.bashrc", "# full\n", 0o600)
        open(os.path.join(full, ".seeded"), "w", encoding="utf-8").close()

        result = self._seed(store=full)

        self.assertIn("adopting it in place", result.stderr)
        self.assertEqual(self._store_file("home/user/keep.txt", store=full),
                         "full-mode data\n")
        self.assertEqual(self._store_file("etc/os-release", store=full),
                         "PRETTY_NAME=Full\n")
        # Missing optional dirs become empty; the volume is not re-seeded.
        self.assertTrue(os.path.isdir(os.path.join(full, "opt")))
        self.assertTrue(os.path.isdir(os.path.join(full, "app")))
        self.assertEqual(self._store_file("etc/hosts", store=full),
                         "10.0.0.1 host\n")
        self.assertTrue(os.path.isfile(
            os.path.join(full, ".clouddesktop-seed/home.done")))
        # The old root's entrypoint cannot know PERSIST_MODE=direct, so the
        # seed refreshes that one helper from the current image.
        self.assertEqual(
            self._store_file("usr/local/bin/persist-entry", store=full),
            "#!/bin/bash\n# direct-capable\n")
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(
            full, "usr/local/bin/persist-entry")).st_mode), 0o755)

    def test_incomplete_full_mode_volume_is_rejected(self):
        full = os.path.join(self.tmp, "full-incomplete")
        self._write(full, "etc/os-release", "x\n", 0o644)
        open(os.path.join(full, ".seeded"), "w", encoding="utf-8").close()

        result = self._seed(store=full, check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incomplete", result.stderr)

    # ── validation ─────────────────────────────────────────────────────────

    def test_nested_mounts_are_rejected(self):
        for bad in ("etc etc/hosts", "usr usr/local"):
            result = self._seed(mounts=bad, check=False)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertIn("is inside the already listed", result.stderr)

    def test_missing_source_directory_is_rejected(self):
        result = self._seed(mounts="etc nope", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no directory '/nope'", result.stderr)

    def test_traversal_and_hidden_paths_are_rejected(self):
        for bad in ("../etc", "etc/../../usr", ".seeded", "/etc/./"):
            result = self._seed(mounts=bad, check=False)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertIn("invalid directory in PERSIST_MOUNTS", result.stderr)

    def test_symlinked_source_is_rejected(self):
        os.symlink("etc", os.path.join(self.image, "optlink"))
        result = self._seed(mounts="etc optlink", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is a symlink", result.stderr)

    def test_persist_root_is_rejected(self):
        result = run(["bash", SEED, "--root", self.image, "--persist", "/",
                      "--mounts", "etc"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not be '/'", result.stderr)

    def test_persist_directory_inside_the_source_is_rejected(self):
        result = self._seed(mounts="persist", store=self.image + "/persist",
                            check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overlaps the persistence volume", result.stderr)


class DirectEntrypointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="direct-entry-test.")
        self.store = os.path.join(self.tmp, "persist")
        os.makedirs(os.path.join(self.store, ".clouddesktop-seed", "dev"))
        open(os.path.join(self.store, ".clouddesktop-seeded"), "w",
             encoding="utf-8").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _marker(self, rel):
        path = os.path.join(self.store, ".clouddesktop-seed",
                            rel + ".done")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w", encoding="utf-8").close()

    def _run(self, mounts, command=None, env=None, store=None,
             use_root_alias=False):
        full_env = {
            "PERSIST_MODE": "direct",
            "PERSIST_MOUNTS": mounts,
            # The tests may run as root (in a container); do not depend on the
            # image's ubuntu account existing.
            "PERSISTENT_ROOT_USER": "root",
        }
        full_env.pop("PERSIST_DIR", None)
        full_env.pop("ROOT_PERSIST_DIR", None)
        if use_root_alias:
            full_env["ROOT_PERSIST_DIR"] = store or self.store
        else:
            full_env["PERSIST_DIR"] = store or self.store
        if env:
            full_env.update(env)
        return run(["bash", ENTRY] + (command or ["/bin/true"]),
                   env=full_env)

    def test_accepts_kubelet_mounted_directories(self):
        self._marker("dev/shm")
        result = self._run("dev/shm")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified dev/shm on the persistent volume",
                      result.stderr)

    def test_accepts_root_persist_dir_fallback(self):
        self._marker("dev/shm")
        result = self._run("dev/shm", use_root_alias=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_passes_the_command_and_its_exit_status(self):
        self._marker("dev/shm")
        result = self._run("dev/shm", ["/bin/sh", "-c", "exit 7"])
        self.assertEqual(result.returncode, 7, result.stderr)

    def test_rejects_a_directory_still_on_the_root_filesystem(self):
        self._marker("etc")
        result = self._run("etc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not a mount", result.stderr)
        self.assertIn("volumeMounts:", result.stderr)

    def test_rejects_directories_from_different_volumes(self):
        if os.stat("/dev/shm").st_dev == os.stat("/dev/pts").st_dev:
            self.skipTest("/dev/shm and /dev/pts are on the same device here")
        self._marker("dev/shm")
        self._marker("dev/pts")
        result = self._run("dev/shm dev/pts")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("different filesystem", result.stderr)

    def test_rejects_a_missing_seed_marker(self):
        result = self._run("dev/shm")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("seed marker for '/dev/shm' is missing", result.stderr)

    def test_rejects_an_unseeded_volume(self):
        self._marker("dev/shm")
        os.remove(os.path.join(self.store, ".clouddesktop-seeded"))
        result = self._run("dev/shm")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("was not seeded", result.stderr)

    def test_rejects_a_missing_volume_mount(self):
        self._marker("dev/shm")
        result = self._run("dev/shm", store=os.path.join(self.tmp, "absent"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not mounted", result.stderr)

    def test_rejects_unsafe_and_volatile_paths(self):
        for bad in ("../etc", "proc", "sys", "dev"):
            result = self._run(bad)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertIn("persist-entry:", result.stderr)

    def test_rejects_nested_mounts(self):
        result = self._run("dev/shm dev/shm/nested")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is inside the already listed", result.stderr)

    def test_rejects_a_symlinked_mount_path(self):
        result = self._run("bin")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is a symlink", result.stderr)


class DirectManifestTest(unittest.TestCase):
    """Keep the manifest, the seed script and the entrypoint in sync."""

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST, encoding="utf-8") as handle:
            cls.text = handle.read()

    def test_manifest_mounts_every_listed_directory(self):
        listed = self.text.count(
            'value: "etc home opt root srv usr var app"')
        self.assertEqual(listed, 2,
                         "PERSIST_MOUNTS must be set identically on the seed "
                         "initContainer and the desktop container")
        for rel in MOUNTS.split():
            self.assertIn("mountPath: /%s, subPath: %s" % (rel, rel),
                          self.text)

    def test_manifest_checks_markers_through_a_read_only_mount(self):
        self.assertIn("mountPath: /persist, readOnly: true", self.text)

    def test_manifest_needs_no_capabilities_or_privileged_mode(self):
        # Ignore comments: they explain what the manifest deliberately omits.
        config = "\n".join(line.split("#", 1)[0]
                           for line in self.text.splitlines())
        self.assertNotIn("privileged: true", config)
        self.assertNotIn("SYS_ADMIN", config)
        self.assertNotIn("appArmorProfile", config)
        self.assertNotIn("seccompProfile", config)
        for line in config.splitlines():
            self.assertFalse(line.strip().startswith("add:"),
                             "the manifest must not add capabilities")

    def test_seed_script_is_the_init_container_command(self):
        self.assertIn("/usr/local/bin/seed-root", self.text)
        self.assertIn("args:", self.text)
        self.assertIn("--persist", self.text)


if __name__ == "__main__":
    unittest.main()

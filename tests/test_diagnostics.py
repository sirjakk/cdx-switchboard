import tempfile
import unittest
from pathlib import Path

from cdx_switchboard.diagnostics import alternate_binaries
from cdx_switchboard.storage import AccountStore, Paths, atomic_json
from cdx_switchboard.t3_settings import connection_status


class DiagnosticsTests(unittest.TestCase):
    def test_distinct_installations_are_reported_but_symlinks_are_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("selected", "duplicate", "alias"):
                (root / name).mkdir()
            selected = root / "selected/codex"
            duplicate = root / "duplicate/codex"
            for binary in (selected, duplicate):
                binary.write_text("#!/bin/sh\nexit 0\n")
                binary.chmod(0o755)
            (root / "alias/codex").symlink_to(selected)
            path = ":".join(str(root / p) for p in ("alias", "duplicate", "selected", "duplicate"))
            self.assertEqual(alternate_binaries(str(selected), path), [str(duplicate)])

    def test_t3_status_checks_settings_instead_of_trusting_old_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AccountStore(Paths(root / "vault", root / "codex"))
            settings = root / "settings.json"
            launcher = root / "cdx-codex"
            launcher.touch()
            atomic_json(store.paths.data_home / "t3-integration.json", {"status": "connected"})
            atomic_json(settings, {"providerInstances": {}})
            self.assertIn("not connected", connection_status(store, settings, launcher))
            atomic_json(settings, {"providerInstances": {"codex": {
                "driver": "codex", "config": {"binaryPath": str(launcher)}}}})
            self.assertEqual(connection_status(store, settings, launcher), "connected")
            atomic_json(settings, {"providers": {"codex": {"binaryPath": str(launcher)}}})
            self.assertEqual(connection_status(store, settings, launcher), "connected")


if __name__ == "__main__":
    unittest.main()

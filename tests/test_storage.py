import json
from pathlib import Path
import tempfile
import unittest

from cdx_switchboard.auth import auth_profile
from cdx_switchboard.storage import AccountStore, Paths, StoreError, atomic_write
from tests.helpers import auth_bytes


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = AccountStore(Paths(root / "data", root / "codex"))

    def tearDown(self):
        self.temp.cleanup()

    def test_activate_saves_outgoing_rotated_token(self):
        first = self.store.add(auth_bytes("one", "one@example.com", 100), "one")
        second = self.store.add(auth_bytes("two", "two@example.com", 100), "two")
        self.store.activate(first)
        atomic_write(self.store.paths.live_auth, auth_bytes("one", "one@example.com", 200))
        self.store.activate(second)

        saved = json.loads(first.auth_path.read_bytes())
        self.assertEqual(auth_profile(saved).identity, "sub:one")
        self.assertIn("refresh-one-200", first.auth_path.read_text())
        live = json.loads(self.store.paths.live_auth.read_bytes())
        self.assertEqual(auth_profile(live).identity, "sub:two")

    def test_older_live_token_does_not_overwrite_newer_stored_token(self):
        account = self.store.add(auth_bytes("one", "one@example.com", 300), "one")
        self.store.activate(account)
        atomic_write(self.store.paths.live_auth, auth_bytes("one", "one@example.com", 200))
        self.assertFalse(self.store.sync_live_to_active())
        self.assertIn("refresh-one-300", account.auth_path.read_text())

    def test_identity_mismatch_blocks_relogin(self):
        account = self.store.add(auth_bytes("one", "one@example.com"), "one")
        with self.assertRaises(StoreError):
            self.store.replace_auth(account, auth_bytes("two", "two@example.com"))

    def test_ambiguous_selector_fails(self):
        self.store.add(auth_bytes("one", "one@example.com"), "work-one")
        self.store.add(auth_bytes("two", "two@example.com"), "work-two")
        with self.assertRaises(StoreError):
            self.store.resolve("work")

    def test_private_permissions(self):
        account = self.store.add(auth_bytes("one", "one@example.com"), "one")
        self.assertEqual(account.home.stat().st_mode & 0o777, 0o700)
        self.assertEqual(account.auth_path.stat().st_mode & 0o777, 0o600)

    def test_reserved_aliases_are_case_insensitive(self):
        with self.assertRaises(StoreError):
            self.store.add(auth_bytes("one", "one@example.com"), "Best")


if __name__ == "__main__":
    unittest.main()

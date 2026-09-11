import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from unittest.mock import patch
import sqlite3
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from cdx_switchboard.managed import Authority, RefreshServer, runtime_home, setup
from cdx_switchboard.storage import AccountStore, Paths, atomic_json, atomic_write, StoreError
from tests.helpers import auth_bytes


class ManagedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.store = AccountStore(Paths(root / "vault", root / "shared"))
        self.one = self.store.add(auth_bytes("one", "one@example.com"), "one")
        self.two = self.store.add(auth_bytes("two", "two@example.com"), "two")
        self.store.activate(self.one)
        self.client = Mock(binary="/usr/bin/true")
        setup(self.store, self.client)

    def test_managed_switch_changes_selection_without_touching_global_login(self):
        previous = self.store.paths.live_auth.read_bytes()
        self.store.activate(self.two)
        self.assertEqual(self.store.active_id(), self.two.account_id)
        self.assertEqual(self.store.paths.live_auth.read_bytes(), previous)
        self.store.sync_live_to_active()
        self.assertEqual(self.store.active_id(), self.two.account_id)

    def test_setup_imports_unknown_live_login_once(self):
        self.store.paths.managed.unlink()
        atomic_write(self.store.paths.live_auth, auth_bytes("new", "new@example.com"))
        setup(self.store, self.client)
        self.assertEqual(self.store.active_account().alias, "new")
        setup(self.store, self.client)
        self.assertEqual(len(self.store.accounts()), 3)

    def test_worker_auth_is_private_and_pinned_when_selection_changes(self):
        with runtime_home(self.store, self.one, self.client) as (home, env):
            self.assertFalse((home / "auth.json").is_symlink())
            self.assertTrue((home / "sessions").is_symlink())
            self.assertEqual((home / "auth.json").stat().st_mode & 0o777, 0o600)
            self.store.activate(self.two)
            atomic_write(home / "auth.json", auth_bytes("one", "one@example.com", 200))
            self.assertIn("refresh-one-100", self.one.auth_path.read_text())
            self.assertIn("127.0.0.1", env["CODEX_REFRESH_TOKEN_URL_OVERRIDE"])
        self.assertFalse(home.exists())

    def test_concurrent_refresh_returns_one_rotation_to_both_workers(self):
        original = "refresh-one-100"
        def rotate(home, **kwargs):
            time.sleep(0.1)
            atomic_write(home / "auth.json", auth_bytes("one", "one@example.com", 200))
        self.client.refresh.side_effect = rotate
        authorities = [Authority(self.one, self.client), Authority(self.one, self.client)]
        results = []
        threads = [threading.Thread(target=lambda a=a: results.append(a.refresh(original))) for a in authorities]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertEqual(len(results), 2)
        self.client.refresh.assert_called_once()
        self.assertTrue(all(r["refresh_token"] == "refresh-one-200" for r in results))

    def test_old_worker_gets_new_login_after_relogin_for_same_account(self):
        authority = Authority(self.one, self.client)
        self.store.replace_auth(self.one, auth_bytes("one", "one@example.com", 300))
        self.assertEqual(authority.refresh("refresh-one-100")["refresh_token"], "refresh-one-300")
        self.client.refresh.assert_not_called()

    def test_delayed_worker_write_cannot_roll_back_vault(self):
        with runtime_home(self.store, self.one, self.client) as (home, _env):
            self.store.replace_auth(self.one, auth_bytes("one", "one@example.com", 300))
            atomic_write(home / "auth.json", auth_bytes("one", "one@example.com", 100))
            self.assertIn("refresh-one-300", self.one.auth_path.read_text())

    def test_nested_commands_do_not_call_the_worker_callback_as_authority(self):
        from cdx_switchboard.codex import client_environment
        with patch.dict("os.environ", {
            "CDX_MANAGED_RUNTIME": "1", "CODEX_REFRESH_TOKEN_URL_OVERRIDE": "http://worker/refresh",
            "CODEX_REVOKE_TOKEN_URL_OVERRIDE": "http://worker/revoke",
            "CDX_ORIGINAL_REFRESH_URL": "http://test-authority/token",
        }, clear=True):
            env = client_environment()
        self.assertEqual(env["CODEX_REFRESH_TOKEN_URL_OVERRIDE"], "http://test-authority/token")
        self.assertNotIn("CODEX_REVOKE_TOKEN_URL_OVERRIDE", env)
        self.assertNotIn("CDX_MANAGED_RUNTIME", env)

    def test_nested_commands_find_original_shared_home(self):
        with patch.dict("os.environ", {"CDX_SWITCHBOARD_HOME": str(self.store.paths.data_home),
                                      "CODEX_HOME": "/temporary/worker/home"}):
            self.assertEqual(Paths.discover().codex_home, self.store.paths.codex_home)

    def test_t3_busy_check_distinguishes_active_turns_from_idle_sessions(self):
        from cdx_switchboard.t3_settings import busy
        database = self.store.paths.data_home / "state.sqlite"
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE projection_thread_sessions (provider_name TEXT, status TEXT)")
            db.execute("INSERT INTO projection_thread_sessions VALUES ('codex', 'ready')")
        self.assertFalse(busy(database))
        with sqlite3.connect(database) as db:
            db.execute("UPDATE projection_thread_sessions SET status='running'")
        self.assertTrue(busy(database))

    def test_authority_rejects_wrong_account_credentials(self):
        atomic_write(self.one.auth_path, auth_bytes("two", "two@example.com", 300))
        with self.assertRaises(StoreError):
            Authority(self.one, self.client).snapshot()

    def test_callback_rejects_unissued_token_and_worker_logout_preserves_vault(self):
        auth = json.loads(self.one.auth_path.read_bytes())
        previous = self.one.auth_path.read_bytes()
        with RefreshServer(Authority(self.one, self.client), auth) as callback:
            env = callback.environment
            request = Request(env["CODEX_REFRESH_TOKEN_URL_OVERRIDE"],
                              data=json.dumps({"refresh_token": "unissued"}).encode(),
                              headers={"Content-Type": "application/json"})
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 401)
            error.exception.close()
            request = Request(env["CODEX_REVOKE_TOKEN_URL_OVERRIDE"],
                              data=json.dumps({"token": "refresh-one-100"}).encode(),
                              headers={"Content-Type": "application/json"})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(self.one.auth_path.read_bytes(), previous)
        self.client.refresh.assert_not_called()

    def test_t3_connection_preserves_other_providers_and_keeps_backup(self):
        from cdx_switchboard.t3_settings import connect
        settings = self.store.paths.data_home / "t3/settings.json"
        launcher = self.store.paths.data_home / "cdx-codex"
        launcher.touch()
        original = {"unrelated": True, "providerInstances": {
            "codex": {"driver": "codex", "config": {"binaryPath": "codex", "customModels": ["custom"]}},
            "other": {"driver": "other", "enabled": False},
        }}
        atomic_json(settings, original)
        connect(self.store, settings, launcher)
        result = json.loads(settings.read_text())
        self.assertEqual(result["providerInstances"]["other"], original["providerInstances"]["other"])
        self.assertEqual(result["providerInstances"]["codex"]["config"]["customModels"], ["custom"])
        backup = self.store.paths.data_home / "t3-settings-before-managed.json"
        self.assertEqual(json.loads(backup.read_text())["settings"], original)
        connect(self.store, settings, launcher)
        self.assertEqual(json.loads(backup.read_text())["settings"], original)


if __name__ == "__main__":
    unittest.main()

import unittest
import io
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

from cdx_switchboard.cli import _rank, cmd_use, cmd_relogin, cmd_login, current_account, main, _select_for_handoff, build_parser
from cdx_switchboard.handoff import AccountSelection
from cdx_switchboard.storage import AccountStore, Paths, atomic_write
from tests.helpers import auth_bytes


class CliTests(unittest.TestCase):
    def test_login_needs_no_account_name(self):
        args = build_parser().parse_args(["login"])
        self.assertEqual(args.command, "login")
        self.assertFalse(args.device)

    def test_switch_accepts_an_optional_account(self):
        args = build_parser().parse_args(["switch"])
        self.assertEqual(args.command, "switch")
        self.assertIsNone(args.account)
        args = build_parser().parse_args(["switch", "support"])
        self.assertEqual(args.account, "support")
        with self.assertRaises(SystemExit):
            build_parser().parse_args(["switch", "--force"])

    def test_handoff_best_switch_never_forces(self):
        expected = AccountSelection("one", "one", False)
        with patch("cdx_switchboard.cli.cmd_use", return_value=expected) as use:
            result = _select_for_handoff(Mock(), Mock(), None)
        self.assertEqual(result, expected)
        use.assert_called_once()
        self.assertEqual(use.call_args.args[2], "best")
        self.assertFalse(use.call_args.kwargs["force"])

    def test_handoff_passes_named_account_without_forcing(self):
        expected = AccountSelection("support", "support-id", True)
        with patch("cdx_switchboard.cli.cmd_use", return_value=expected) as use:
            result = _select_for_handoff(Mock(), Mock(), "support")
        self.assertEqual(result, expected)
        self.assertEqual(use.call_args.args[2], "support")
        self.assertFalse(use.call_args.kwargs["force"])


class AccountFlowTests(unittest.TestCase):
    def test_rank_recognizes_new_plain_codex_login(self):
        fresh = auth_bytes("two", "two@example.com", 300)
        atomic_write(self.store.paths.live_auth, fresh)
        _rank(self.store, self.client)
        self.assertEqual(self.store.active_id(), self.two.account_id)
        self.assertEqual(self.two.auth_path.read_bytes(), fresh)
        self.client.rate_limits.assert_any_call(self.store.paths.codex_home)
        self.assertNotIn(self.two.home, [c.args[0] for c in self.client.rate_limits.call_args_list])

    def test_current_recognizes_plain_codex_login(self):
        atomic_write(self.store.paths.live_auth, auth_bytes("two", "two@example.com", 300))
        self.assertEqual(current_account(self.store).account_id, self.two.account_id)

    def test_launcher_preserves_plain_login_even_when_not_in_vault(self):
        fresh = auth_bytes("other", "other@example.com", 300)
        atomic_write(self.store.paths.live_auth, fresh)
        self.client.launch.side_effect = RuntimeError("exec replaces process")
        with patch("cdx_switchboard.cli.AccountStore", return_value=self.store), patch(
            "cdx_switchboard.cli.CodexClient", return_value=self.client
        ), self.assertRaisesRegex(RuntimeError, "exec replaces process"):
            main([])
        self.assertEqual(self.store.paths.live_auth.read_bytes(), fresh)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.store = AccountStore(Paths(root / "data", root / "codex"))
        self.one = self.store.add(auth_bytes("one", "one@example.com"), "one")
        self.two = self.store.add(auth_bytes("two", "two@example.com"), "two")
        self.store.activate(self.one)
        self.client = Mock()
        self.client.rate_limits.return_value = {"rateLimits": {
            "primary": {"usedPercent": 10, "windowDurationMins": 300},
        }}
        self.output = redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)
        processes = patch("cdx_switchboard.codex.running_codex_processes", side_effect=AssertionError("must not gate on processes"))
        processes.start()
        self.addCleanup(processes.stop)

    def test_use_switches_without_process_gate_or_force(self):
        cmd_use(self.store, self.client, "two", False)
        self.assertEqual(self.store.active_id(), self.two.account_id)
        self.assertEqual(self.store.paths.live_auth.read_bytes(), self.two.auth_path.read_bytes())

    def test_active_relogin_succeeds_without_process_gate(self):
        fresh = auth_bytes("one", "one@example.com", 200)
        self.client.login.return_value = fresh
        cmd_relogin(self.store, self.client, "one", True)
        self.assertEqual(self.store.paths.live_auth.read_bytes(), fresh)

    def test_relogin_does_not_reactivate_account_switched_during_browser_flow(self):
        def login(*args, **kwargs):
            self.store.activate(self.two)
            return auth_bytes("one", "one@example.com", 200)
        self.client.login.side_effect = login
        cmd_relogin(self.store, self.client, "one", True)
        self.assertEqual(self.store.paths.live_auth.read_bytes(), self.two.auth_path.read_bytes())

    def test_login_activates_without_process_gate(self):
        self.client.login.return_value = auth_bytes("three", "three@example.com")
        cmd_login(self.store, self.client, True)
        self.assertEqual(self.store.active_account().alias, "three")

    def test_rank_uses_live_home_and_saves_rotated_token(self):
        response = self.client.rate_limits.return_value
        def limits(home):
            if home == self.store.paths.codex_home:
                atomic_write(home / "auth.json", auth_bytes("one", "one@example.com", 200))
            return response
        self.client.rate_limits.side_effect = limits
        _rank(self.store, self.client)
        self.assertIn("refresh-one-200", self.one.auth_path.read_text())
        self.client.rate_limits.assert_any_call(self.store.paths.codex_home)

    def test_rank_does_not_probe_or_overwrite_unrelated_live_login(self):
        other = auth_bytes("other", "other@example.com", 300)
        atomic_write(self.store.paths.live_auth, other)
        _rank(self.store, self.client)
        self.client.rate_limits.assert_any_call(self.one.home)
        self.assertEqual(self.store.paths.live_auth.read_bytes(), other)


if __name__ == "__main__":
    unittest.main()

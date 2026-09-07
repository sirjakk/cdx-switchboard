import unittest
from unittest.mock import Mock, patch

from cdx_switchboard.cli import _assert_switch_safe, _select_for_handoff, build_parser
from cdx_switchboard.handoff import AccountSelection
from cdx_switchboard.storage import StoreError


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

    def test_t3_process_warning_points_to_safe_handoff(self):
        process = "codex app-server -c mcp_servers.t3-code.url=http://127.0.0.1"
        with patch("cdx_switchboard.cli.running_codex_processes", return_value=[process]):
            with self.assertRaisesRegex(StoreError, r"cdx switch <account>"):
                _assert_switch_safe(False)

    def test_code_mode_host_warning_points_to_safe_handoff(self):
        with patch(
            "cdx_switchboard.cli.running_codex_processes",
            return_value=["/opt/codex-code-mode-host"],
        ):
            with self.assertRaisesRegex(StoreError, r"cdx switch <account>"):
                _assert_switch_safe(False)


if __name__ == "__main__":
    unittest.main()

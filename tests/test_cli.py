import unittest
from unittest.mock import Mock, patch

from cdx_switchboard.cli import _select_best_for_handoff, build_parser
from cdx_switchboard.handoff import AccountSelection


class CliTests(unittest.TestCase):
    def test_login_needs_no_account_name(self):
        args = build_parser().parse_args(["login"])
        self.assertEqual(args.command, "login")
        self.assertFalse(args.device)

    def test_switch_command_is_registered_without_options(self):
        args = build_parser().parse_args(["switch"])
        self.assertEqual(args.command, "switch")
        with self.assertRaises(SystemExit):
            build_parser().parse_args(["switch", "--force"])

    def test_handoff_best_switch_never_forces(self):
        expected = AccountSelection("one", "one", False)
        with patch("cdx_switchboard.cli.cmd_use", return_value=expected) as use:
            result = _select_best_for_handoff(Mock(), Mock())
        self.assertEqual(result, expected)
        use.assert_called_once()
        self.assertEqual(use.call_args.args[2], "best")
        self.assertFalse(use.call_args.kwargs["force"])


if __name__ == "__main__":
    unittest.main()

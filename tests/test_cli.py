import unittest

from cdx_switchboard.cli import build_parser


class CliTests(unittest.TestCase):
    def test_login_needs_no_account_name(self):
        args = build_parser().parse_args(["login"])
        self.assertEqual(args.command, "login")
        self.assertFalse(args.device)


if __name__ == "__main__":
    unittest.main()

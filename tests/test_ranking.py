from pathlib import Path
import unittest
from unittest.mock import Mock

from cdx_switchboard.ranking import parse_rate_limits, rank_accounts, render_table
from cdx_switchboard.codex import AuthenticationRequired, CodexError
from cdx_switchboard.storage import Account


def account(alias: str) -> Account:
    return Account(alias, alias, f"{alias}@example.com", f"sub:{alias}", "chatgpt", Path("/tmp") / alias, "", "")


class RankingTests(unittest.TestCase):
    def test_server_spend_limit_is_distinguished_from_usage_windows(self):
        row = parse_rate_limits(account("one"), {"rateLimits": {
            "spendControlReached": True,
            "primary": {"usedPercent": 0, "windowDurationMins": 300},
        }})
        self.assertFalse(row.usable)
        self.assertIn("SPEND LIMIT", render_table([row], None))
        self.assertTrue(row.as_json(False, 1)["spend_control_reached"])

    def test_revoked_login_has_actionable_one_line_error(self):
        client = Mock()
        client.rate_limits.side_effect = AuthenticationRequired("revoked")
        rows = rank_accounts([account("one")], client)
        self.assertFalse(rows[0].usable)
        self.assertIn("cdx relogin one", rows[0].error)

    def test_http_body_does_not_break_table(self):
        client = Mock()
        client.rate_limits.side_effect = CodexError('HTTP 500; body={\n"error": "server failure"\n}')
        table = render_table(rank_accounts([account("one")], client), None)
        self.assertIn("HTTP 500", table)
        self.assertNotIn("server failure", table)

    def test_parses_windows_and_credits(self):
        row = parse_rate_limits(account("one"), {
            "rateLimits": {
                "planType": "plus",
                "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 2000000000},
                "secondary": {"usedPercent": 60, "windowDurationMins": 10080, "resetsAt": 2000100000},
            },
            "rateLimitResetCredits": {"availableCount": 2, "credits": []},
        })
        self.assertEqual(row.ready, 40)
        self.assertEqual(row.budget, 40)
        self.assertEqual([window.label for window in row.windows], ["5h", "7d"])
        self.assertEqual(row.credits, 2)
        self.assertTrue(row.usable)

    def test_rate_limit_reached_is_not_usable(self):
        row = parse_rate_limits(account("one"), {
            "rateLimits": {
                "planType": "plus",
                "rateLimitReachedType": "rate_limit_reached",
                "primary": {"usedPercent": 100, "windowDurationMins": 300},
            }
        })
        self.assertFalse(row.usable)

    def test_active_account_can_be_probed_through_live_codex_home(self):
        one = account("one")
        live_home = Path("/tmp/live-codex-home")
        client = Mock()
        client.rate_limits.return_value = {
            "rateLimits": {
                "primary": {"usedPercent": 10, "windowDurationMins": 300},
            }
        }
        rank_accounts([one], client, {one.account_id: live_home})
        client.rate_limits.assert_called_once_with(live_home)


if __name__ == "__main__":
    unittest.main()

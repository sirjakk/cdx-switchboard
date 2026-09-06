from pathlib import Path
import unittest
from unittest.mock import Mock

from cdx_switchboard.ranking import parse_rate_limits, rank_accounts
from cdx_switchboard.storage import Account


def account(alias: str) -> Account:
    return Account(alias, alias, f"{alias}@example.com", f"sub:{alias}", "chatgpt", Path("/tmp") / alias, "", "")


class RankingTests(unittest.TestCase):
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

import json
import unittest

from cdx_switchboard.auth import AuthError, auth_profile, default_alias
from tests.helpers import auth_bytes


class AuthTests(unittest.TestCase):
    def test_extracts_stable_identity_and_email(self):
        profile = auth_profile(json.loads(auth_bytes("user-1", "One@Example.com")))
        self.assertEqual(profile.identity, "sub:user-1")
        self.assertEqual(profile.email, "One@Example.com")
        self.assertEqual(profile.method, "chatgpt")

    def test_rejects_unrecognized_file(self):
        with self.assertRaises(AuthError):
            auth_profile({"tokens": {}})

    def test_default_alias_is_unique(self):
        profile = auth_profile(json.loads(auth_bytes("user-1", "me@example.com")))
        self.assertEqual(default_alias(profile, {"me", "me-2"}), "me-3")


if __name__ == "__main__":
    unittest.main()

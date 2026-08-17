from pathlib import Path
import json
import stat
import tempfile
import textwrap
import unittest

from cdx_switchboard.codex import CodexClient
from tests.helpers import auth_bytes


FAKE_CODEX = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

if sys.argv[1] == "login":
    Path(os.environ["CODEX_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["CODEX_HOME"], "login-args.json").write_text(json.dumps(sys.argv[2:]))
    Path(os.environ["CODEX_HOME"], "auth.json").write_bytes(%r)
    raise SystemExit(0)

if sys.argv[1] == "app-server":
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("id") == 1:
            print(json.dumps({"id": 1, "result": {}}), flush=True)
        if message.get("id") == 2:
            print(json.dumps({"id": 2, "result": {
                "rateLimits": {
                    "planType": "plus",
                    "primary": {"usedPercent": 10, "windowDurationMins": 300}
                },
                "rateLimitResetCredits": {"availableCount": 0, "credits": []}
            }}), flush=True)
'''


class CodexProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binary = self.root / "codex"
        self.binary.write_text(FAKE_CODEX % auth_bytes("one", "one@example.com"))
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.client = CodexClient(str(self.binary))

    def tearDown(self):
        self.temp.cleanup()

    def test_login_uses_isolated_home(self):
        stage = self.root / "stage"
        auth = self.client.login(stage)
        self.assertIn(b"refresh-one", auth)
        args = json.loads((stage / "login-args.json").read_text())
        self.assertNotIn("--device-auth", args)

    def test_device_login_is_an_explicit_option(self):
        stage = self.root / "device-stage"
        self.client.login(stage, device_auth=True)
        args = json.loads((stage / "login-args.json").read_text())
        self.assertIn("--device-auth", args)

    def test_reads_rate_limits_from_app_server(self):
        response = self.client.rate_limits(self.root / "account", timeout=2)
        self.assertEqual(response["rateLimits"]["primary"]["usedPercent"], 10)


if __name__ == "__main__":
    unittest.main()

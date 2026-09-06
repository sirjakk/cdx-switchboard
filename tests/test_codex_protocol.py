from pathlib import Path
import json
import stat
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from cdx_switchboard.codex import CodexClient, running_codex_processes
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
    Path(os.environ["CODEX_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["CODEX_HOME"], "clean-shutdown").write_text("done")
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
        account_home = self.root / "account"
        response = self.client.rate_limits(account_home, timeout=2)
        self.assertEqual(response["rateLimits"]["primary"]["usedPercent"], 10)
        self.assertEqual((account_home / "clean-shutdown").read_text(), "done")

    def test_macos_process_guard_detects_codex_app_server(self):
        ps = subprocess.CompletedProcess(
            [],
            0,
            "12345 /usr/local/bin/codex app-server\n12346 /usr/bin/python worker.py\n",
            "",
        )
        with patch("cdx_switchboard.codex.Path.is_dir", return_value=False), patch(
            "cdx_switchboard.codex.subprocess.run", return_value=ps
        ):
            matches = running_codex_processes()
        self.assertEqual(matches, ["/usr/local/bin/codex app-server"])


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import json
import stat
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from cdx_switchboard.codex import AuthenticationRequired, CodexClient, CodexError, running_codex_processes
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

    def recovery_server(self, mode):
        self.binary.write_text(textwrap.dedent('''\
            #!/usr/bin/env python3
            import json, os, sys
            from pathlib import Path
            home = Path(os.environ["CODEX_HOME"])
            home.mkdir(parents=True, exist_ok=True)
            mode = MODE
            requests = []
            for line in sys.stdin:
                message = json.loads(line)
                requests.append(message)
                request_id = message.get("id")
                if request_id is None:
                    continue
                result = {}
                error = None
                if request_id == 2:
                    error = {"message": "HTTP 500" if mode == "server-error" else "401 Unauthorized; token_revoked"}
                elif request_id == 3:
                    assert message["method"] == "account/read"
                    assert message["params"] == {"refreshToken": True}
                    if mode == "refresh-revoked":
                        error = {"message": "refresh_token_reused: refresh token has already been used"}
                    elif mode == "refresh-network-error":
                        error = {"message": "refresh token request: connection timed out"}
                    else:
                        result = {"account": None if mode == "logged-out" else {"type": "chatgpt"}}
                elif request_id == 4:
                    if mode == "still-revoked":
                        error = {"message": "401 Unauthorized"}
                    else:
                        result = {"rateLimits": {"primary": {"usedPercent": 10}}}
                response = {"id": request_id, "error": error} if error else {"id": request_id, "result": result}
                # One write with a notification and a response reproduces the
                # buffered-pipe timeout that a select + readline loop can hit.
                sys.stdout.write(json.dumps({"method": "account/updated"}) + "\\n" + json.dumps(response) + "\\n")
                sys.stdout.flush()
            (home / "requests.json").write_text(json.dumps(requests))
            (home / "clean-shutdown").write_text("done")
        ''').replace("MODE", repr(mode)))

    def test_unauthorized_usage_refreshes_once_and_retries(self):
        self.recovery_server("recover")
        home = self.root / "recovery"
        result = self.client.rate_limits(home, timeout=2)
        self.assertEqual(result["rateLimits"]["primary"]["usedPercent"], 10)
        requests = json.loads((home / "requests.json").read_text())
        self.assertEqual([r["method"] for r in requests if r.get("id")], [
            "initialize", "account/rateLimits/read", "account/read", "account/rateLimits/read",
        ])

    def test_revoked_refresh_and_retry_failures_require_login_without_looping(self):
        for mode in ("refresh-revoked", "still-revoked", "logged-out"):
            with self.subTest(mode=mode):
                self.recovery_server(mode)
                home = self.root / mode
                with self.assertRaises(AuthenticationRequired):
                    self.client.rate_limits(home, timeout=2)
                self.assertTrue((home / "clean-shutdown").exists())
                requests = json.loads((home / "requests.json").read_text())
                self.assertEqual(sum(r["method"] == "account/read" for r in requests), 1)

    def test_network_failures_are_not_mislabeled_as_revoked_login(self):
        self.recovery_server("refresh-network-error")
        with self.assertRaisesRegex(CodexError, "connection timed out") as raised:
            self.client.rate_limits(self.root / "network", timeout=2)
        self.assertNotIsInstance(raised.exception, AuthenticationRequired)

    def test_non_auth_error_does_not_refresh(self):
        self.recovery_server("server-error")
        home = self.root / "server-error"
        with self.assertRaisesRegex(CodexError, "HTTP 500"):
            self.client.rate_limits(home, timeout=2)
        requests = json.loads((home / "requests.json").read_text())
        self.assertFalse(any(r["method"] == "account/read" for r in requests))

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

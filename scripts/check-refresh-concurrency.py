#!/usr/bin/env python3
"""Exercise installed Codex refresh concurrency with synthetic local credentials.

No real login is read. OAuth and backend URLs point to a temporary loopback
server. This checks client behavior, not OpenAI's token-revocation policy.
"""

import base64
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from cdx_switchboard.codex import CodexClient
from cdx_switchboard.storage import AccountStore, Paths
from cdx_switchboard.managed import setup


ACCOUNT = "00000000-0000-4000-8000-000000000001"


def token():
    claims = {
        "sub": "synthetic-user", "email": "test@example.invalid",
        "iat": int(time.time()), "exp": int(time.time()) + 86400,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": ACCOUNT, "chatgpt_plan_type": "plus",
            "chatgpt_user_id": "synthetic-user",
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{payload}.test"


def check(binary, *, process_count, separate_homes, managed=False):
    seen = []
    guard = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            refresh = data.get("refresh_token")
            with guard:
                reused = refresh in seen
                seen.append(refresh)
                number = len(seen)
            time.sleep(0.5)
            body = (
                {"error": {"code": "refresh_token_reused", "message": "synthetic token already consumed"}}
                if reused else
                {"access_token": token(), "id_token": token(), "refresh_token": f"synthetic-rotated-{number}"}
            )
            self.send_response(401 if reused else 200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def do_GET(self):
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    processes = []
    try:
        with tempfile.TemporaryDirectory(prefix="cdx-refresh-check-") as tmp:
            url = f"http://127.0.0.1:{server.server_port}"
            for index in range(process_count):
                home = Path(tmp) / (str(index) if separate_homes else "shared")
                home.mkdir(exist_ok=True)
                if not (home / "auth.json").exists():
                    (home / "auth.json").write_text(json.dumps({
                        "auth_mode": "chatgpt",
                        "tokens": {"access_token": token(), "id_token": token(),
                                   "refresh_token": f"synthetic-original-{index}", "account_id": ACCOUNT},
                        "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }))
                env = {k: v for k, v in os.environ.items() if not any(
                    marker in k for marker in ("TOKEN", "API_KEY", "FEDERATION", "AUTHAPI", "IDENTITY")
                )}
                env.update(CODEX_HOME=str(home), CODEX_REFRESH_TOKEN_URL_OVERRIDE=url + "/token")
                command = [binary]
                if managed:
                    vault = Path(tmp) / (f"vault-{index}" if separate_homes else "vault")
                    store = AccountStore(Paths(vault, home))
                    if not store.accounts():
                        account = store.add((home / "auth.json").read_bytes(), "synthetic")
                        store.activate(account)
                        setup(store, CodexClient(binary))
                    env.update(CDX_SWITCHBOARD_HOME=str(vault), CDX_CODEX_BIN=binary)
                    command = [sys.executable, str(Path(__file__).resolve().parents[1] / "cdx-codex")]
                process = subprocess.Popen(
                    [*command, "app-server", "-c", 'cli_auth_credentials_store="file"',
                     "-c", f'chatgpt_base_url="{url}"'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env=env, bufsize=0,
                )
                processes.append(process)
                CodexClient._send(process.stdin, {"id": 1, "method": "initialize", "params": {
                    "clientInfo": {"name": "cdx-auth-diagnostic", "version": "1"},
                }})
                if CodexClient._read_response(process, 1, 10).get("error"):
                    raise RuntimeError("initialization failed")
                CodexClient._send(process.stdin, {"method": "initialized", "params": None})
            requests = [(processes[index % process_count], index + 2) for index in range(2)]
            for process, request_id in requests:
                CodexClient._send(process.stdin, {"id": request_id, "method": "account/read",
                                                 "params": {"refreshToken": True}})
            # Each process receives responses in request order for these auth
            # calls because its auth manager serializes refresh requests.
            results = [CodexClient._read_response(p, request_id, 15) for p, request_id in requests]
            return {"managed": managed, "processes": process_count, "separate_homes": separate_homes,
                    "refresh_requests": len(seen), "reused_token": len(seen) != len(set(seen)),
                    "authenticated": [bool(r.get("result", {}).get("account")) for r in results]}
    finally:
        for process in processes:
            process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            process.stdout.close()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--managed", action="store_true", help="check the coordinated cdx launcher")
    args = parser.parse_args()
    binary = shutil.which("codex")
    if not binary:
        raise SystemExit("codex is not on PATH")
    for count, separate in ((2, False), (1, False), (2, True)):
        result = check(binary, process_count=count, separate_homes=separate, managed=args.managed)
        print(json.dumps(result), flush=True)
        if args.managed and (result["reused_token"] or not all(result["authenticated"])):
            raise SystemExit("managed refresh concurrency check failed")

"""Command-line interface for cdx-switchboard."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import getpass
import io
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile

from . import __version__
from .codex import CodexClient, CodexError
from .handoff import AccountSelection, HandoffError, perform_handoff, schedule_handoff
from .ranking import rank_accounts, render_json, render_table
from .storage import Account, AccountStore, StoreError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cdx",
        description="Safely store, rank, and switch between your Codex CLI accounts.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    login = sub.add_parser("login", aliases=["add"], help="sign in and store another account")
    login.add_argument("--device", action="store_true", help="use device-code login instead of browser login")

    relogin = sub.add_parser("relogin", help="refresh the stored login for an account")
    relogin.add_argument("account", nargs="?", help="alias, email, or account number (defaults to active)")
    relogin.add_argument("--device", action="store_true", help="use device-code login instead of browser login")

    rank = sub.add_parser("rank", help="rank accounts by immediately usable headroom")
    rank.add_argument("--json", action="store_true", help="emit machine-readable JSON")

    use = sub.add_parser("use", help="switch the active Codex login")
    use.add_argument("account", nargs="?", help="alias, email, rank number, or 'best'")
    use.add_argument("--force", action="store_true", help=argparse.SUPPRESS)

    switch = sub.add_parser("switch", help="hand off to an account and restart T3")
    switch.add_argument(
        "account",
        nargs="?",
        help="alias, email, account number, or 'best' (defaults to best)",
    )

    sub.add_parser("list", aliases=["ls"], help="list stored accounts without network access")
    sub.add_parser("current", help="show the active account")

    imported = sub.add_parser("import-current", help="store the current ~/.codex/auth.json")
    imported.add_argument("alias", nargs="?")

    doctor = sub.add_parser("doctor", help="check Codex and credential-storage configuration")
    doctor.add_argument("--verbose", action="store_true")
    setup_parser = sub.add_parser("setup", help="enable account-pinned sessions and coordinated token refresh")
    setup_parser.add_argument("--t3", action="store_true", help="connect the default T3 Codex provider")
    repair = sub.add_parser("repair", help="sign in again only to accounts with unrecoverable logins")
    repair.add_argument("--device", action="store_true", help="use device-code login")
    return parser


def _staging_dir(store: AccountStore) -> Path:
    staging_root = store.paths.data_home / ".staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    staging_root.chmod(0o700)
    return Path(tempfile.mkdtemp(prefix="login-", dir=staging_root))


def _tunnel_command() -> str:
    connection = os.environ.get("SSH_CONNECTION", "").split()
    if len(connection) == 4:
        host = connection[2]
        port = connection[3]
    else:
        host = socket.gethostname()
        port = "22"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port_option = f"-p {port} " if port != "22" else ""
    return f"ssh {port_option}-N -L 1455:127.0.0.1:1455 {getpass.getuser()}@{host}"


def _print_tunnel_help() -> None:
    print("Browser login needs an SSH tunnel for the localhost callback.")
    print("On the computer with your browser, open a second terminal and run:")
    print()
    print(f"  {_tunnel_command()}")
    print()
    print("Use the same SSH host and port you normally use, and leave that command running")
    print("until login finishes. Then open the authorization URL printed below.")
    print()


def _rank(store: AccountStore, client: CodexClient, *, as_json: bool = False):
    accounts = store.accounts()
    if not accounts:
        raise StoreError("no accounts stored; run `cdx login`")
    with store.locked():
        store.sync_live_to_active()
        active = store.active_account()
        # Always use the canonical home for its matching account. Process
        # presence says nothing about account identity or token freshness.
        use_live = not store.paths.managed.is_file() and active is not None and store.live_matches(active)
        account_homes = (
            {active.account_id: store.paths.codex_home}
            if use_live
            else None
        )
        if store.paths.managed.is_file():
            from .managed import Authority
            authorities = {a.home: Authority(a, client) for a in accounts}
            class ManagedRankClient:
                def rate_limits(self, home):
                    return authorities[home].rate_limits()
            rows = rank_accounts(accounts, ManagedRankClient())
        else:
            rows = rank_accounts(accounts, client, account_homes)
        store.save_rank([row.account for row in rows])
        if use_live:
            store.sync_live_to_active()
    output = render_json(rows, store.active_id()) if as_json else render_table(rows, store.active_id())
    print(output)
    return rows


def cmd_login(store: AccountStore, client: CodexClient, device: bool) -> None:
    staging = _staging_dir(store)
    try:
        if device:
            print("Starting Codex device-code login...")
        else:
            if os.environ.get("SSH_CONNECTION"):
                _print_tunnel_help()
            print("Starting Codex browser login...")
        auth_bytes = client.login(staging, device_auth=device)
        with store.locked():
            if not store.active_account() and store.paths.live_auth.is_file():
                previous = store.import_live()
                store.activate(previous)
                print(f"Preserved the existing Codex login as {previous.alias!r}.")
            account = store.add(auth_bytes)
            store.activate(account)
            print(f"Stored and activated {account.alias!r} ({account.email or account.method}).")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_relogin(
    store: AccountStore,
    client: CodexClient,
    selector: str | None,
    device: bool,
) -> None:
    with store.locked():
        store.sync_live_to_active()
    account = store.resolve(selector)
    staging = _staging_dir(store)
    try:
        method = "device-code" if device else "browser"
        print(f"Re-authenticating {account.alias!r} with {method} login...")
        if not device and os.environ.get("SSH_CONNECTION"):
            _print_tunnel_help()
        auth_bytes = client.login(staging, device_auth=device)
        with store.locked():
            current = store.resolve(account.account_id)
            from .managed import account_lock
            with account_lock(current):
                updated = store.replace_auth(current, auth_bytes)
            if account.account_id == store.active_id():
                store.copy_to_live(updated)
            print(f"Updated {updated.alias!r}; the stored identity was verified before replacement.")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_use(
    store: AccountStore,
    client: CodexClient,
    selector: str | None,
    force: bool,
) -> AccountSelection | None:
    with store.locked():
        store.sync_live_to_active()
    previous_id = store.active_id()
    if selector == "best" or selector is None:
        rows = _rank(store, client)
        if selector is None:
            if not sys.stdin.isatty():
                raise StoreError("`cdx use` needs an account in non-interactive shells")
            selector = input("Account number to activate (blank cancels): ").strip()
            if not selector:
                print("Cancelled.")
                return None
        else:
            usable = next((row for row in rows if row.usable), None)
            if not usable:
                raise StoreError("no usable account is available")
            selector = usable.account.account_id
    account = store.resolve(selector)
    with store.locked():
        store.activate(account)
    print(f"Active Codex account: {account.alias} ({account.email or account.method})")
    return AccountSelection(account.account_id, account.alias, account.account_id != previous_id)


def current_account(store: AccountStore) -> Account:
    with store.locked():
        store.sync_live_to_active()
    account = store.active_account()
    if not account:
        raise StoreError("no active account")
    return account


def _select_for_handoff(
    store: AccountStore,
    client: CodexClient,
    selector: str | None,
) -> AccountSelection:
    # Ranking output is intentionally discarded: the helper log contains only
    # high-level handoff events and never credential or process details.
    with redirect_stdout(io.StringIO()):
        selection = cmd_use(store, client, selector or "best", force=False)
    assert selection is not None
    return selection


def _launcher_path() -> Path:
    candidate = shutil.which(sys.argv[0]) or sys.argv[0]
    return Path(candidate).resolve()


def _run_switch_helper(
    store: AccountStore,
    client: CodexClient,
    selector: str | None,
) -> None:
    perform_handoff(
        lambda: _select_for_handoff(store, client, selector),
        lambda: current_account(store).account_id,
    )


def cmd_list(store: AccountStore) -> None:
    with store.locked():
        store.sync_live_to_active()
    accounts = store.accounts()
    active = store.active_id()
    if not accounts:
        print("No accounts stored. Run `cdx login`.")
        return
    for account in accounts:
        mark = "*" if account.account_id == active else " "
        print(f"{mark} {account.alias:<18} {account.email or account.method}")


def cmd_doctor(store: AccountStore, client: CodexClient, verbose: bool) -> int:
    from .diagnostics import alternate_binaries, codex_version
    failures = 0
    try:
        client.ensure_available()
        print(f"ok  Codex CLI: {codex_version(client.binary)} at {client.binary}")
        for binary in alternate_binaries(client.binary):
            try:
                version = codex_version(binary)
            except CodexError:
                version = "version unavailable"
            print(f"WARN another Codex installation on PATH: {version} at {binary}")
            print("     Shells and apps can select different copies. Use one canonical installation.")
    except CodexError as exc:
        print(f"ERR {exc}")
        failures += 1
    print(f"ok  switchboard data: {store.paths.data_home}")
    if store.paths.managed.is_file():
        print("ok  managed sessions: account pinned per process, token refresh coordinated")
        from .t3_settings import connection_status
        status = connection_status(store)
        print(f"{'ok' if status == 'connected' else 'WARN'}  T3: {status}")
    active = store.active_account()
    if active:
        print(f"ok  active account: {active.alias}")
    else:
        print("WARN no active switchboard account")
    if store.paths.live_auth.is_file():
        mode = store.paths.live_auth.stat().st_mode & 0o777
        status = "ok" if mode & 0o077 == 0 else "WARN"
        print(f"{status:<4} live auth mode: {mode:04o}")
    else:
        print(f"WARN no live auth file at {store.paths.live_auth}")
    config = store.paths.codex_home / "config.toml"
    if config.is_file() and "cli_auth_credentials_store = \"keyring\"" in config.read_text(errors="replace"):
        print("WARN config forces keyring credentials; launch Codex through `cdx` to force file credentials")
    elif verbose:
        print("ok  no explicit keyring-only credential setting detected")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> None:
    args_list = list(sys.argv[1:] if argv is None else argv)
    store = AccountStore()
    if store.paths.managed.is_file():
        from .managed import managed_client
        client = managed_client(store)
    else:
        client = CodexClient()

    if args_list and args_list[0] == "_switch-helper":
        if len(args_list) > 2:
            print("cdx: invalid switch-helper arguments", file=sys.stderr)
            raise SystemExit(2)
        try:
            _run_switch_helper(store, client, args_list[1] if len(args_list) == 2 else None)
        except (StoreError, CodexError, HandoffError) as exc:
            print(f"cdx: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        return

    # `cdx` is also the safe launcher. Arguments beginning with '-' pass through
    # to Codex, while named switchboard commands are parsed below.
    if not args_list or (args_list and args_list[0].startswith("-") and args_list[0] not in {"--help", "--version"}):
        try:
            if store.paths.managed.is_file():
                from .managed import run
                raise SystemExit(run(store, client, args_list))
            with store.locked():
                store.sync_live_to_active()
                # A plain Codex login is already ready to launch. Recopying a
                # vault snapshot here could replace it with an older session.
                if not store.paths.live_auth.is_file():
                    account = store.active_account()
                    if not account:
                        raise StoreError("no active account; run `cdx login`")
                    store.activate(account)
            client.launch(store.paths.codex_home, args_list)
        except (StoreError, CodexError) as exc:
            print(f"cdx: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc

    parser = build_parser()
    args = parser.parse_args(args_list)
    try:
        if args.command in {"login", "add"}:
            cmd_login(store, client, args.device)
        elif args.command == "relogin":
            cmd_relogin(store, client, args.account, args.device)
        elif args.command == "rank":
            _rank(store, client, as_json=args.json)
        elif args.command == "use":
            cmd_use(store, client, args.account, args.force)
        elif args.command == "switch":
            log_path = schedule_handoff(_launcher_path(), args.account)
            print("Detached account handoff scheduled; T3 will stop and restart.")
            print(f"Temporary log: {log_path}")
            print("After T3 reconnects, reopen this thread and say `continue`.")
        elif args.command in {"list", "ls"}:
            cmd_list(store)
        elif args.command == "current":
            account = current_account(store)
            print(f"{account.alias}\t{account.email or account.method}")
        elif args.command == "import-current":
            with store.locked():
                account = store.import_live(args.alias)
                store.activate(account)
            print(f"Imported and activated {account.alias!r}.")
        elif args.command == "doctor":
            raise SystemExit(cmd_doctor(store, client, args.verbose))
        elif args.command == "setup":
            from .managed import setup
            setup(store, client)
            if args.t3:
                from .t3_settings import connect_or_schedule
                print(f"T3: {connect_or_schedule(store)}")
            print("Managed accounts enabled. cdx use selects new sessions; cdx switch also restarts T3.")
        elif args.command == "repair":
            rows = _rank(store, client)
            failed = [row for row in rows if row.error and "cdx relogin" in row.error]
            if not failed:
                print("No accounts need a new login.")
            for row in failed:
                cmd_relogin(store, client, row.account.account_id, args.device)
        else:
            parser.print_help()
    except (StoreError, CodexError, HandoffError) as exc:
        print(f"cdx: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

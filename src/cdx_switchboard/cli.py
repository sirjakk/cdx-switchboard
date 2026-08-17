"""Command-line interface for cdx-switchboard."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import sys
import tempfile

from . import __version__
from .codex import CodexClient, CodexError, running_codex_processes
from .ranking import rank_accounts, render_json, render_table
from .storage import AccountStore, StoreError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cdx",
        description="Safely store, rank, and switch between your Codex CLI accounts.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    login = sub.add_parser("login", aliases=["add"], help="sign in and store another account")
    login.add_argument("alias", nargs="?", help="short local name such as work or personal")
    login.add_argument("--browser", action="store_true", help="use localhost browser login instead of device code")

    relogin = sub.add_parser("relogin", help="refresh the stored login for an account")
    relogin.add_argument("account", nargs="?", help="alias, email, or account number (defaults to active)")
    relogin.add_argument("--browser", action="store_true", help="use localhost browser login instead of device code")

    rank = sub.add_parser("rank", help="rank accounts by immediately usable headroom")
    rank.add_argument("--json", action="store_true", help="emit machine-readable JSON")

    use = sub.add_parser("use", help="switch the active Codex login")
    use.add_argument("account", nargs="?", help="alias, email, rank number, or 'best'")
    use.add_argument("--force", action="store_true", help="switch even if another Codex process appears active")

    sub.add_parser("list", aliases=["ls"], help="list stored accounts without network access")
    sub.add_parser("current", help="show the active account")

    imported = sub.add_parser("import-current", help="store the current ~/.codex/auth.json")
    imported.add_argument("alias", nargs="?")

    doctor = sub.add_parser("doctor", help="check Codex and credential-storage configuration")
    doctor.add_argument("--verbose", action="store_true")
    return parser


def _staging_dir(store: AccountStore) -> Path:
    staging_root = store.paths.data_home / ".staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    staging_root.chmod(0o700)
    return Path(tempfile.mkdtemp(prefix="login-", dir=staging_root))


def _assert_switch_safe(force: bool) -> None:
    processes = running_codex_processes()
    if processes and not force:
        raise StoreError(
            "a Codex process appears to be running; exit it before switching "
            "(or use --force if you know it cannot write auth.json)"
        )


def _rank(store: AccountStore, client: CodexClient, *, as_json: bool = False):
    accounts = store.accounts()
    if not accounts:
        raise StoreError("no accounts stored; run `cdx login <alias>`")
    with store.locked():
        store.sync_live_to_active()
        rows = rank_accounts(accounts, client)
        store.save_rank([row.account for row in rows])
        active = store.active_account()
        if active and not running_codex_processes():
            # app-server may have refreshed a stored token while reading usage.
            # Carry that newer token into the canonical Codex home.
            store.copy_to_live(active)
    output = render_json(rows, store.active_id()) if as_json else render_table(rows, store.active_id())
    print(output)
    return rows


def cmd_login(store: AccountStore, client: CodexClient, alias: str | None, browser: bool) -> None:
    staging = _staging_dir(store)
    try:
        print("Starting Codex browser login..." if browser else "Starting Codex device-code login for SSH...")
        auth_bytes = client.login(staging, device_auth=not browser)
        with store.locked():
            if not store.active_account() and store.paths.live_auth.is_file():
                previous = store.import_live()
                store.activate(previous)
                print(f"Preserved the existing Codex login as {previous.alias!r}.")
            account = store.add(auth_bytes, alias)
            if running_codex_processes():
                print(f"Stored {account.alias!r}; left the current account active because Codex is running.")
            else:
                store.activate(account)
                print(f"Stored and activated {account.alias!r} ({account.email or account.method}).")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_relogin(
    store: AccountStore,
    client: CodexClient,
    selector: str | None,
    browser: bool,
) -> None:
    account = store.resolve(selector)
    is_active = account.account_id == store.active_id()
    if is_active:
        _assert_switch_safe(False)
    staging = _staging_dir(store)
    try:
        method = "browser" if browser else "device-code"
        print(f"Re-authenticating {account.alias!r} with {method} login...")
        auth_bytes = client.login(staging, device_auth=not browser)
        with store.locked():
            current = store.resolve(account.account_id)
            updated = store.replace_auth(current, auth_bytes)
            if is_active:
                store.copy_to_live(updated)
            print(f"Updated {updated.alias!r}; the stored identity was verified before replacement.")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_use(store: AccountStore, client: CodexClient, selector: str | None, force: bool) -> None:
    if selector == "best" or selector is None:
        rows = _rank(store, client)
        if selector is None:
            if not sys.stdin.isatty():
                raise StoreError("`cdx use` needs an account in non-interactive shells")
            selector = input("Account number to activate (blank cancels): ").strip()
            if not selector:
                print("Cancelled.")
                return
        else:
            usable = next((row for row in rows if row.usable), None)
            if not usable:
                raise StoreError("no usable account is available")
            selector = usable.account.account_id
    account = store.resolve(selector)
    _assert_switch_safe(force)
    with store.locked():
        store.activate(account)
    print(f"Active Codex account: {account.alias} ({account.email or account.method})")


def cmd_list(store: AccountStore) -> None:
    accounts = store.accounts()
    active = store.active_id()
    if not accounts:
        print("No accounts stored. Run `cdx login <alias>`.")
        return
    for account in accounts:
        mark = "*" if account.account_id == active else " "
        print(f"{mark} {account.alias:<18} {account.email or account.method}")


def cmd_doctor(store: AccountStore, client: CodexClient, verbose: bool) -> int:
    failures = 0
    try:
        client.ensure_available()
        print(f"ok  Codex CLI: {client.binary}")
    except CodexError as exc:
        print(f"ERR {exc}")
        failures += 1
    print(f"ok  switchboard data: {store.paths.data_home}")
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
    client = CodexClient()

    # `cdx` is also the safe launcher. Arguments beginning with '-' pass through
    # to Codex, while named switchboard commands are parsed below.
    if not args_list or (args_list and args_list[0].startswith("-") and args_list[0] not in {"--help", "--version"}):
        try:
            account = store.active_account()
            if not account:
                raise StoreError("no active account; run `cdx login <alias>`")
            with store.locked():
                store.activate(account)
            client.launch(store.paths.codex_home, args_list)
        except (StoreError, CodexError) as exc:
            print(f"cdx: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc

    parser = build_parser()
    args = parser.parse_args(args_list)
    try:
        if args.command in {"login", "add"}:
            cmd_login(store, client, args.alias, args.browser)
        elif args.command == "relogin":
            cmd_relogin(store, client, args.account, args.browser)
        elif args.command == "rank":
            _rank(store, client, as_json=args.json)
        elif args.command == "use":
            cmd_use(store, client, args.account, args.force)
        elif args.command in {"list", "ls"}:
            cmd_list(store)
        elif args.command == "current":
            account = store.active_account()
            if not account:
                raise StoreError("no active account")
            print(f"{account.alias}\t{account.email or account.method}")
        elif args.command == "import-current":
            with store.locked():
                account = store.import_live(args.alias)
                store.activate(account)
            print(f"Imported and activated {account.alias!r}.")
        elif args.command == "doctor":
            raise SystemExit(cmd_doctor(store, client, args.verbose))
        else:
            parser.print_help()
    except (StoreError, CodexError) as exc:
        print(f"cdx: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

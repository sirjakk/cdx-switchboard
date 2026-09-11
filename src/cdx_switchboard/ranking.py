"""Rate-limit parsing and deterministic account ranking."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from typing import Any

from .codex import AuthenticationRequired, CodexClient, CodexError
from .storage import Account


def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def format_duration(seconds: int | float | None) -> str:
    if seconds is None:
        return "?"
    seconds = max(0, int(seconds))
    if seconds >= 172800:
        return f"{math.ceil(seconds / 86400)}d"
    if seconds >= 3600:
        return f"{seconds // 3600}h"
    if seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


@dataclass(frozen=True)
class Window:
    label: str
    remaining: int
    resets_at: int | None
    duration_minutes: int | None

    @property
    def reset_in(self) -> int | None:
        return None if self.resets_at is None else max(0, self.resets_at - _now_ts())

    def display(self) -> str:
        return f"{self.label}:{self.remaining}%/{format_duration(self.reset_in)}"


@dataclass
class RankedAccount:
    account: Account
    plan: str = "?"
    windows: list[Window] = field(default_factory=list)
    credits: int = 0
    reached: bool = False
    error: str | None = None

    @property
    def ready(self) -> int:
        return min((window.remaining for window in self.windows), default=0)

    @property
    def budget(self) -> int:
        if not self.windows:
            return 0
        return max(self.windows, key=lambda window: window.duration_minutes or 0).remaining

    @property
    def usable(self) -> bool:
        return not self.error and bool(self.windows) and not self.reached and self.ready > 0

    @property
    def sort_key(self) -> tuple[int, int, int, int]:
        longest = max(self.windows, key=lambda window: window.duration_minutes or 0, default=None)
        reset = longest.reset_in if longest and longest.reset_in is not None else 10**12
        return (int(self.usable), self.ready, self.budget, -reset)

    def as_json(self, active: bool, rank: int) -> dict[str, Any]:
        return {
            "rank": rank,
            "active": active,
            "alias": self.account.alias,
            "email": self.account.email,
            "plan": self.plan,
            "usable": self.usable,
            "ready_percent": self.ready,
            "budget_percent": self.budget,
            "credits": self.credits,
            "error": self.error,
            "windows": [
                {
                    "label": window.label,
                    "remaining_percent": window.remaining,
                    "resets_at": window.resets_at,
                    "duration_minutes": window.duration_minutes,
                }
                for window in self.windows
            ],
        }


def _window_label(minutes: int | None, fallback: str) -> str:
    if minutes is None:
        return fallback
    if minutes >= 7 * 24 * 60:
        return "7d"
    if minutes >= 24 * 60:
        return f"{round(minutes / 1440)}d"
    if minutes >= 60:
        return f"{round(minutes / 60)}h"
    return f"{minutes}m"


def parse_rate_limits(account: Account, response: dict[str, Any]) -> RankedAccount:
    snapshot: Any = None
    by_id = response.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and by_id:
        snapshot = by_id.get("codex") or next(iter(by_id.values()))
    if not isinstance(snapshot, dict):
        snapshot = response.get("rateLimits")
    if not isinstance(snapshot, dict):
        return RankedAccount(account=account, error="no rate-limit snapshot")

    row = RankedAccount(
        account=account,
        plan=str(snapshot.get("planType") or "?"),
        reached=bool(snapshot.get("rateLimitReachedType") or snapshot.get("spendControlReached")),
    )
    for key, fallback in (("primary", "primary"), ("secondary", "secondary")):
        raw = snapshot.get(key)
        if not isinstance(raw, dict) or raw.get("usedPercent") is None:
            continue
        duration = raw.get("windowDurationMins")
        duration = int(duration) if isinstance(duration, (int, float)) else None
        used = max(0, min(100, int(raw["usedPercent"])))
        resets = raw.get("resetsAt")
        resets = int(resets) if isinstance(resets, (int, float)) else None
        row.windows.append(Window(_window_label(duration, fallback), 100 - used, resets, duration))
    credits = response.get("rateLimitResetCredits")
    if isinstance(credits, dict):
        row.credits = max(0, int(credits.get("availableCount") or 0))
    return row


def rank_accounts(
    accounts: list[Account],
    client: CodexClient,
    account_homes: dict[str, Path] | None = None,
) -> list[RankedAccount]:
    rows: list[RankedAccount] = []
    for account in accounts:
        try:
            home = (account_homes or {}).get(account.account_id, account.home)
            rows.append(parse_rate_limits(account, client.rate_limits(home)))
        except AuthenticationRequired:
            rows.append(RankedAccount(
                account=account,
                error=f"login expired or revoked; run `cdx relogin {account.alias}`",
            ))
        except (CodexError, OSError, ValueError) as exc:
            rows.append(RankedAccount(account=account, error=str(exc)))
    return sorted(rows, key=lambda row: row.sort_key, reverse=True)


def render_table(rows: list[RankedAccount], active_id: str | None) -> str:
    if not rows:
        return "No accounts stored. Run `cdx login <alias>`."
    alias_width = max(7, min(24, max(len(row.account.alias) for row in rows)))
    lines = [
        f"{'#':>2}  {'ACCOUNT':<{alias_width}}  {'PLAN':<10}  {'AVAILABLE / RESET':<34}  STATUS",
        f"{'--':>2}  {'-' * alias_width}  {'-' * 10}  {'-' * 34}  {'-' * 12}",
    ]
    for index, row in enumerate(rows, 1):
        active = "*" if row.account.account_id == active_id else " "
        windows = "  ".join(window.display() for window in row.windows) or "-"
        if row.error:
            # Keep network response bodies and newlines out of the table.
            message = " ".join(row.error.split("body=", 1)[0].split())
            status = f"ERROR: {message[:180]}"
        elif row.reached or not row.usable:
            status = "LIMITED"
        else:
            status = "RECOMMENDED" if index == 1 else "ready"
        if row.credits:
            status += f", {row.credits} credit{'s' if row.credits != 1 else ''}"
        lines.append(
            f"{index:>2}{active} {row.account.alias:<{alias_width}}  {row.plan:<10}  {windows:<34}  {status}"
        )
    lines.append("\n* active; `cdx use <number>` uses the numbering from this ranking.")
    return "\n".join(lines)


def render_json(rows: list[RankedAccount], active_id: str | None) -> str:
    return json.dumps(
        [row.as_json(row.account.account_id == active_id, index) for index, row in enumerate(rows, 1)],
        indent=2,
    )

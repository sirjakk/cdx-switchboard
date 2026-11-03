// Usage parsing and account ranking.

import { LoginExpired, shortError } from "./codex.js";
import { isObject } from "./files.js";
import type { Account } from "./store.js";

export interface Window {
  label: string;
  /** Percent of this window still available. */
  remaining: number;
  /** Unix seconds. */
  resetsAt?: number;
  minutes?: number;
}

export interface Usage {
  account: Account;
  plan?: string;
  windows: Window[];
  /** The service says the account is blocked, for example "rateLimitReached". */
  limited: boolean;
  /** Pay-as-you-go credits or an unlimited plan keep an account usable without windows. */
  hasCredits: boolean;
  unlimited: boolean;
  spendControlReached: boolean;
  resetCredits: number;
  /** Unix seconds for each available reset credit, soonest first; null if unknown. */
  resetCreditExpiries: (number | null)[];
  error?: string;
  /** The login cannot be recovered without signing in again. */
  expired?: boolean;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export function emptyUsage(account: Account, extra: Partial<Usage> = {}): Usage {
  return {
    account, windows: [], limited: false, hasCredits: false, unlimited: false, spendControlReached: false,
    resetCredits: 0, resetCreditExpiries: [], ...extra,
  };
}

/** Parse the result of `account/rateLimits/read`. Unknown or malformed fields are ignored. */
export function parseUsage(account: Account, response: Record<string, unknown>): Usage {
  let snapshot: unknown = undefined;
  if (isObject(response.rateLimitsByLimitId)) {
    const byId = response.rateLimitsByLimitId;
    snapshot = byId.codex ?? Object.values(byId).find(isObject);
  }
  if (!isObject(snapshot)) snapshot = response.rateLimits;
  if (!isObject(snapshot)) return emptyUsage(account, { error: "Codex reported no usage information" });

  const credits = isObject(snapshot.credits) ? snapshot.credits : {};
  const usage = emptyUsage(account, {
    plan: typeof snapshot.planType === "string" ? snapshot.planType : undefined,
    // spendControlReached can be true while included usage remains; the
    // server's classified limit state decides whether the account is blocked.
    limited: Boolean(snapshot.rateLimitReachedType) || response.ordinaryUsageAllowed === false,
    spendControlReached: snapshot.spendControlReached === true,
    hasCredits: credits.hasCredits === true,
    unlimited: credits.unlimited === true,
  });
  for (const key of ["primary", "secondary"]) {
    const raw = snapshot[key];
    const used = isObject(raw) ? num(raw.usedPercent) : undefined;
    if (!isObject(raw) || used === undefined) continue;
    const minutes = num(raw.windowDurationMins);
    usage.windows.push({
      label: windowLabel(minutes, key),
      remaining: 100 - Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: num(raw.resetsAt),
      minutes,
    });
  }

  const reset = response.rateLimitResetCredits;
  if (isObject(reset)) {
    usage.resetCredits = Math.max(0, Math.floor(num(reset.availableCount) ?? 0));
    const details = Array.isArray(reset.credits) ? reset.credits.filter(isObject) : [];
    usage.resetCreditExpiries = details
      .filter((credit) => credit.status === "available")
      .map((credit) => num(credit.expiresAt) ?? null)
      .sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a ?? 0) - (b ?? 0))
      .slice(0, usage.resetCredits);
  }
  return usage;
}

/** Percent available right now: the tightest window. */
export function ready(usage: Usage): number {
  if (!usage.windows.length) return usable(usage) ? 100 : 0;
  return Math.min(...usage.windows.map((window) => window.remaining));
}

function longest(usage: Usage): Window | undefined {
  return [...usage.windows].sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0];
}

export function usable(usage: Usage): boolean {
  if (usage.error || usage.limited) return false;
  if (usage.account.method !== "chatgpt") return true;
  if (usage.windows.length) return Math.min(...usage.windows.map((window) => window.remaining)) > 0;
  return usage.unlimited || usage.hasCredits;
}

/** Usable ChatGPT accounts are picked automatically; API keys cost money, so only when named. */
export function autoPick(usage: Usage): boolean {
  return usable(usage) && usage.account.method === "chatgpt";
}

/** Best first: usable ChatGPT accounts, then other usable logins, then the rest; within each, most available now. */
export function compareUsage(a: Usage, b: Usage): number {
  const key = (usage: Usage) => [
    autoPick(usage) ? 2 : usable(usage) ? 1 : 0, ready(usage), longest(usage)?.remaining ?? ready(usage), -(longest(usage)?.resetsAt ?? 1e12),
  ];
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
  return a.account.alias.localeCompare(b.account.alias);
}

/** Probe every account (a few at a time) and sort best first. One failure never hides the rest. */
export async function rankAccounts(accounts: Account[], probe: (account: Account) => Promise<Usage>): Promise<Usage[]> {
  const results: Usage[] = new Array(accounts.length);
  let next = 0;
  const worker = async () => {
    while (next < accounts.length) {
      const index = next++;
      const account = accounts[index]!;
      try {
        results[index] = await probe(account);
      } catch (error) {
        results[index] = emptyUsage(account, error instanceof LoginExpired
          ? { error: `login expired; run \`cdx relogin ${account.alias}\``, expired: true }
          : { error: shortError((error as Error).message) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
  return results.sort(compareUsage);
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "?";
  const s = Math.max(0, Math.round(seconds));
  if (s >= 172_800) return `${Math.ceil(s / 86_400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

function status(usage: Usage, first: boolean): string {
  if (usage.error) return `ERROR: ${usage.error}`;
  if (usage.account.method !== "chatgpt") return "API key (no usage limits reported)";
  let text = !usable(usage) ? (usage.spendControlReached ? "SPEND LIMIT" : "LIMITED") : first && autoPick(usage) ? "RECOMMENDED" : "ready";
  if (!usage.windows.length && usable(usage)) text += usage.unlimited ? " (unlimited)" : " (credits)";
  if (usage.resetCredits) {
    const next = usage.resetCreditExpiries.find((expiry) => expiry !== null);
    const when = next ? `; next expires ${new Date(next * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
    text += `, ${usage.resetCredits} reset credit${usage.resetCredits === 1 ? "" : "s"}${when}`;
  }
  return text;
}

export function renderTable(rows: Usage[], liveId: string | undefined, now = Date.now()): string {
  const width = Math.max(7, ...rows.map((row) => row.account.alias.length));
  const windows = (row: Usage) => row.windows
    .map((w) => `${w.label}:${w.remaining}%/${duration(w.resetsAt === undefined ? undefined : w.resetsAt - now / 1000)}`)
    .join("  ") || "-";
  const lines = [
    ` #  ${"ACCOUNT".padEnd(width)}  ${"PLAN".padEnd(10)}  ${"AVAILABLE / RESETS IN".padEnd(30)}  STATUS`,
    rows.map((row, index) => {
      const mark = row.account.id === liveId ? "*" : " ";
      return `${String(index + 1).padStart(2)}${mark} ${row.account.alias.padEnd(width)}  ${(row.plan ?? "-").padEnd(10)}  `
        + `${windows(row).padEnd(30)}  ${status(row, index === 0 && usable(row))}`;
    }).join("\n"),
    "",
    "* signed in now. `cdx switch <#>` moves Codex and T3 to an account; `cdx switch` picks the best one.",
  ];
  return lines.join("\n");
}

export function toJson(rows: Usage[], liveId: string | undefined): unknown {
  return rows.map((row, index) => ({
    rank: index + 1,
    live: row.account.id === liveId,
    alias: row.account.alias,
    email: row.account.email ?? null,
    method: row.account.method,
    plan: row.plan ?? null,
    usable: usable(row),
    ready_percent: ready(row),
    unlimited: row.unlimited,
    has_credits: row.hasCredits,
    spend_control_reached: row.spendControlReached,
    reset_credits: row.resetCredits,
    reset_credit_expiries: row.resetCreditExpiries,
    error: row.error ?? null,
    windows: row.windows.map((w) => ({ label: w.label, remaining_percent: w.remaining, resets_at: w.resetsAt ?? null, minutes: w.minutes ?? null })),
  }));
}

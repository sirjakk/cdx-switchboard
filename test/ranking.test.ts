import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginExpired } from "../src/codex.js";
import { parseUsage, rankAccounts, ready, renderTable, toJson, usable } from "../src/ranking.js";
import type { Account } from "../src/store.js";

const account = (alias: string, method: Account["method"] = "chatgpt"): Account => ({ id: alias, alias, method, dir: "/nonexistent" });

const snapshot = (primary?: number, secondary?: number, extra: Record<string, unknown> = {}) => ({
  rateLimits: {
    planType: "plus",
    ...(primary === undefined ? {} : { primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 2_000_000_000 } }),
    ...(secondary === undefined ? {} : { secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: 2_000_500_000 } }),
    ...extra,
  },
});

test("parses windows and labels them by length", () => {
  const usage = parseUsage(account("a"), snapshot(25, 60));
  assert.deepEqual(usage.windows.map((w) => [w.label, w.remaining]), [["5h", 75], ["7d", 40]]);
  assert.equal(ready(usage), 40);
  assert.equal(usable(usage), true);
  const monthly = parseUsage(account("a"), { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 43200 } } });
  assert.equal(monthly.windows[0]!.label, "30d");
});

test("an exhausted or blocked account is not usable", () => {
  assert.equal(usable(parseUsage(account("a"), snapshot(100, 10))), false);
  assert.equal(usable(parseUsage(account("a"), snapshot(10, 10, { rateLimitReachedType: "rateLimitReached" }))), false);
  assert.equal(usable(parseUsage(account("a"), { ...snapshot(10), ordinaryUsageAllowed: false })), false);
  // A spend control flag alone does not block included usage.
  assert.equal(usable(parseUsage(account("a"), snapshot(10, 10, { spendControlReached: true }))), true);
});

test("plans without windows are usable when unlimited or with credits", () => {
  assert.equal(usable(parseUsage(account("a"), snapshot(undefined, undefined, { credits: { unlimited: true } }))), true);
  assert.equal(usable(parseUsage(account("a"), snapshot(undefined, undefined, { credits: { hasCredits: true, balance: "5" } }))), true);
  assert.equal(usable(parseUsage(account("a"), snapshot())), false);
  assert.equal(parseUsage(account("a"), {}).error, "Codex reported no usage information");
});

test("prefers the codex limit when several are reported", () => {
  const usage = parseUsage(account("a"), {
    rateLimitsByLimitId: { other: snapshot(90).rateLimits, codex: snapshot(5).rateLimits },
    rateLimits: snapshot(50).rateLimits,
  });
  assert.equal(ready(usage), 95);
});

test("malformed fields are ignored instead of crashing", () => {
  const usage = parseUsage(account("a"), {
    rateLimits: { primary: { usedPercent: "lots" }, secondary: { usedPercent: { x: 1 } }, planType: 7 },
    rateLimitResetCredits: { availableCount: "2", credits: ["x", null, { status: "available", expiresAt: "soon" }] },
  });
  assert.equal(usage.windows.length, 0);
  assert.equal(usage.resetCredits, 0);
});

test("reset credits are listed soonest first", () => {
  const usage = parseUsage(account("a"), {
    ...snapshot(10),
    rateLimitResetCredits: { availableCount: 3, credits: [
      { status: "available", expiresAt: 300 }, { status: "available" }, { status: "used", expiresAt: 1 }, { status: "available", expiresAt: 100 },
    ] },
  });
  assert.deepEqual(usage.resetCreditExpiries, [100, 300, null]);
});

test("ranking puts the most usable account first and keeps going after errors", async () => {
  const responses: Record<string, unknown> = { low: snapshot(90), high: snapshot(10), out: snapshot(100) };
  const rows = await rankAccounts([account("out"), account("low"), account("broken"), account("expired"), account("high"), account("key", "apikey")], async (a) => {
    if (a.alias === "broken") throw new Error("network down body={\"secret\":1}");
    if (a.alias === "expired") throw new LoginExpired("x");
    if (a.alias === "key") return { account: a, windows: [], limited: false, hasCredits: false, unlimited: false, spendControlReached: false, resetCredits: 0, resetCreditExpiries: [] };
    return parseUsage(a, responses[a.alias] as Record<string, unknown>);
  });
  // API keys cost money, so they rank after usable ChatGPT accounts.
  assert.deepEqual(rows.map((r) => r.account.alias).slice(0, 3), ["high", "low", "key"]);
  const broken = rows.find((r) => r.account.alias === "broken")!;
  assert.equal(broken.error, "network down");
  assert.equal(rows.find((r) => r.account.alias === "expired")!.expired, true);
  const table = renderTable(rows, "low");
  assert.match(table, /low/);
  assert.ok(!table.includes("secret"));
  const json = toJson(rows, "low") as { alias: string; live: boolean }[];
  assert.equal(json.find((row) => row.alias === "low")!.live, true);
});

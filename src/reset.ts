// Redeem an earned usage reset without ever spending two by accident.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Codex } from "./codex.js";
import { CdxError, isObject, readJson, writeJson } from "./files.js";
import type { Account, Store } from "./store.js";

/**
 * Redeem the available reset credit that expires soonest. The request's
 * idempotency key is saved before the call and removed only once the outcome
 * is known, so rerunning after a timeout retries the same redemption.
 */
export async function consumeReset(store: Store, codex: Codex, account: Account): Promise<void> {
  await store.locked(() => store.accountLocked(account, async () => {
    const home = store.probeHome(account, (await store.reconcile())?.id);
    const pendingFile = path.join(account.dir, "pending-reset.json");
    const saved = readJson(pendingFile);
    let params: Record<string, unknown>;
    if (isObject(saved) && typeof saved.idempotencyKey === "string") {
      params = { idempotencyKey: saved.idempotencyKey, ...(typeof saved.creditId === "string" ? { creditId: saved.creditId } : {}) };
      console.log("Retrying the previous reset attempt for this account.");
    } else {
      const limits = await codex.rateLimits(home);
      const summary = isObject(limits.rateLimitResetCredits) ? limits.rateLimitResetCredits : {};
      if (!(typeof summary.availableCount === "number" && summary.availableCount > 0)) {
        throw new CdxError(`${account.alias} has no reset credits`);
      }
      const now = Date.now() / 1000;
      const credits = (Array.isArray(summary.credits) ? summary.credits : []).filter(isObject).filter((credit) =>
        credit.status === "available" && typeof credit.id === "string"
        && (credit.expiresAt == null || (typeof credit.expiresAt === "number" && credit.expiresAt > now)));
      credits.sort((a, b) => (typeof a.expiresAt === "number" ? a.expiresAt : Infinity) - (typeof b.expiresAt === "number" ? b.expiresAt : Infinity));
      params = { idempotencyKey: crypto.randomUUID() };
      if (credits[0]) params.creditId = credits[0].id;
      else console.log("Credit details are unavailable; the service will choose the credit.");
      writeJson(pendingFile, { ...params, created_at: new Date().toISOString() });
    }

    let result: Record<string, unknown>;
    try {
      result = await codex.consumeReset(home, params);
    } catch (error) {
      throw new CdxError(`the reset was not confirmed (${(error as Error).message}); `
        + `run the same \`cdx reset\` again to retry it safely`);
    }
    switch (result.outcome) {
      case "reset":
      case "alreadyRedeemed":
        fs.rmSync(pendingFile, { force: true });
        return;
      case "noCredit":
      case "nothingToReset":
        fs.rmSync(pendingFile, { force: true });
        throw new CdxError(`${account.alias} ${result.outcome === "noCredit" ? "has no reset credits" : "has no used-up limit to reset"}; nothing was spent`);
      default:
        throw new CdxError(`Codex gave an unknown reset result; run the same \`cdx reset\` again to retry safely `
          + `(to start over instead, delete ${pendingFile})`);
    }
  }));
}

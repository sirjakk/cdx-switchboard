// End-to-end tests of the cdx command against a fake Codex in a sandbox.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { chatgptAuth, type Sandbox, sandbox } from "./helpers.js";

let box: Sandbox;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

function limits(byEmail: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(byEmail).map(([email, used]) => [email,
    typeof used === "number"
      ? { response: { rateLimits: { planType: "plus", primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 2_000_000_000 } } } }
      : used]));
}

/** ann is live; bob and cat are saved. */
function threeAccounts() {
  for (const email of ["bob@x.com", "cat@x.com", "ann@x.com"]) {
    box.writeLive(chatgptAuth({ email }));
    assert.equal(box.cdx(["list"]).status, 0);
  }
}

const liveEmail = () => {
  const tokens = box.readLive().tokens as Record<string, string>;
  return JSON.parse(Buffer.from(tokens.id_token!.split(".")[1]!, "base64url").toString()).email;
};

test("first run saves the current login, and rank --json stays valid JSON", () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com" }));
  const result = box.cdx(["rank", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows[0].alias, "ann");
  assert.equal(rows[0].live, true);
  assert.match(result.stderr, /saved the current Codex login as ann/);
});

test("switch moves the live login, verifies it, and keeps the outgoing login", () => {
  threeAccounts();
  box.setFixtures({ limits: limits({ "bob@x.com": 20 }) });
  const result = box.cdx(["switch", "bob"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /now uses bob/);
  assert.equal(liveEmail(), "bob@x.com");
  const verify = box.calls().find((call) => call.method === "account/read");
  assert.equal(verify?.home, box.codexHome);
  // The verification reads the login as Codex is configured, without forcing file storage.
  assert.deepEqual(verify?.args, ["app-server"]);
  assert.match(box.cdx(["current"]).stdout, /^bob\t/);
});

test("switch refuses an account with no usage and changes nothing", () => {
  threeAccounts();
  box.setFixtures({ limits: limits({ "bob@x.com": 100 }) });
  const result = box.cdx(["switch", "bob"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no usage left; nothing was changed/);
  assert.equal(liveEmail(), "ann@x.com");
});

test("switch with no account picks the one with the most usage", () => {
  threeAccounts();
  box.setFixtures({ limits: limits({ "ann@x.com": 95, "bob@x.com": 60, "cat@x.com": 5 }) });
  const result = box.cdx(["switch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveEmail(), "cat@x.com");
});

test("switching to the live account is a no-op", () => {
  threeAccounts();
  const result = box.cdx(["switch", "ann"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already uses ann/);
});

test("a rank number refers to the last ranking", () => {
  threeAccounts();
  box.setFixtures({ limits: limits({ "ann@x.com": 50, "bob@x.com": 10, "cat@x.com": 90 }) });
  assert.equal(box.cdx(["rank"]).status, 0);
  assert.equal(box.cdx(["use", "1"]).status, 0);
  assert.equal(liveEmail(), "bob@x.com");
});

test("usage of the live account is read from the live home, others from the vault", () => {
  threeAccounts();
  box.cdx(["rank"]);
  const reads = box.calls().filter((call) => call.method === "account/rateLimits/read");
  const ann = reads.find((call) => call.email === "ann@x.com")!;
  const bob = reads.find((call) => call.email === "bob@x.com")!;
  assert.equal(ann.home, box.codexHome);
  assert.match(String(bob.home), new RegExp(`^${box.dataHome}/accounts/`));
});

test("a rejected access token is refreshed once, in place, then retried", () => {
  threeAccounts();
  box.setFixtures({ limits: { "bob@x.com": { needsRefresh: true } } });
  const result = box.cdx(["rank", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const bob = JSON.parse(result.stdout).find((row: { alias: string }) => row.alias === "bob");
  assert.equal(bob.error, null);
  const dir = path.join(box.dataHome, "accounts", fs.readdirSync(path.join(box.dataHome, "accounts"))
    .find((id) => fs.readFileSync(path.join(box.dataHome, "accounts", id, "account.json"), "utf8").includes('"bob"'))!);
  assert.match(fs.readFileSync(path.join(dir, "auth.json"), "utf8"), /rotated/);
});

test("an expired login is reported with the fix, without hiding other accounts", () => {
  threeAccounts();
  box.setFixtures({ limits: { "bob@x.com": { expired: true } } });
  const result = box.cdx(["rank"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /login expired; run `cdx relogin bob`/);
  assert.match(result.stdout, /RECOMMENDED/);
  assert.ok(!result.stdout.includes("secret"));
});

test("switching is refused when Codex does not read auth.json", () => {
  threeAccounts();
  box.setFixtures({ accountRead: { type: "chatgpt", email: "keyring-user@x.com" } });
  const result = box.cdx(["use", "bob"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not using .*auth\.json/);
  assert.equal(liveEmail(), "ann@x.com");
});

test("an empty --alias is rejected before signing in", () => {
  const result = box.cdx(["login", "--alias="]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /an alias is/);
  assert.equal(box.calls().filter((call) => call.cmd === "login").length, 0);
});

test("keyring storage is refused with instructions", () => {
  threeAccounts();
  fs.writeFileSync(path.join(box.codexHome, "config.toml"), "model = 'x'\ncli_auth_credentials_store = 'keyring'\n[profiles.a]\n");
  const result = box.cdx(["switch", "bob"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"keyring" storage/);
  assert.equal(liveEmail(), "ann@x.com");
  assert.equal(box.cdx(["doctor"]).status, 1);
});

test("login saves a new account in a private staging home and switches to it", () => {
  threeAccounts();
  const source = path.join(box.root, "new-login.json");
  fs.writeFileSync(source, JSON.stringify(chatgptAuth({ email: "dan@x.com" })));
  const result = box.cdx(["login", "--alias", "dan-work"], { env: { FAKE_LOGIN_AUTH: source } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveEmail(), "dan@x.com");
  assert.match(box.cdx(["list"]).stdout, /\* dan-work/);
  const login = box.calls().find((call) => call.cmd === "login")!;
  assert.notEqual(login.home, box.codexHome);
  assert.equal(fs.readdirSync(path.join(box.dataHome, ".staging")).length, 0);
});

test("login of an already saved account updates it instead of adding a duplicate", () => {
  threeAccounts();
  const source = path.join(box.root, "again.json");
  fs.writeFileSync(source, JSON.stringify(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-ann-new", refreshed: "2026-10-10T00:00:00Z" })));
  assert.equal(box.cdx(["login"], { env: { FAKE_LOGIN_AUTH: source } }).status, 0);
  assert.equal((box.readLive().tokens as Record<string, string>).refresh_token, "rt-ann-new");
  assert.equal(box.cdx(["list"]).stdout.split("\n").filter((line) => /^[ *] ann\s/.test(line)).length, 1);
});

test("over SSH, browser login prints a tunnel command for the callback port", () => {
  const source = path.join(box.root, "new-login.json");
  fs.writeFileSync(source, JSON.stringify(chatgptAuth({ email: "dan@x.com" })));
  const result = box.cdx(["login"], { env: { FAKE_LOGIN_AUTH: source, SSH_CONNECTION: "100.64.0.2 51000 100.64.0.9 2222" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ssh -o ExitOnForwardFailure=yes -p 2222 -N -L localhost:1455:localhost:1455 \S+@100\.64\.0\.9/);
});

test("relogin refuses a login for a different account", () => {
  threeAccounts();
  const source = path.join(box.root, "wrong.json");
  fs.writeFileSync(source, JSON.stringify(chatgptAuth({ email: "eve@x.com" })));
  const result = box.cdx(["relogin", "bob"], { env: { FAKE_LOGIN_AUTH: source } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different account than bob/);
});

test("relogin of the live account updates the live login too", () => {
  threeAccounts();
  const source = path.join(box.root, "fresh.json");
  fs.writeFileSync(source, JSON.stringify(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-ann-fresh", refreshed: "2026-10-11T00:00:00Z" })));
  assert.equal(box.cdx(["relogin"], { env: { FAKE_LOGIN_AUTH: source } }).status, 0);
  assert.equal((box.readLive().tokens as Record<string, string>).refresh_token, "rt-ann-fresh");
});

test("reset keeps its idempotency key until the outcome is known", () => {
  threeAccounts();
  const credits = { rateLimitResetCredits: { availableCount: 2, credits: [
    { id: "late", status: "available", expiresAt: 4_000_000_000 }, { id: "soon", status: "available", expiresAt: 3_000_000_000 },
  ] } };
  box.setFixtures({ limits: { "bob@x.com": { response: { rateLimits: { primary: { usedPercent: 100 } }, ...credits } } }, consume: { "bob@x.com": { error: "timed out" } } });
  const first = box.cdx(["reset", "bob"]);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /run the same `cdx reset` again/);
  box.setFixtures({ limits: limits({ "bob@x.com": 0 }), consume: { "bob@x.com": { outcome: "reset" } } });
  const second = box.cdx(["reset", "bob"]);
  assert.equal(second.status, 0, second.stderr);
  const consumes = box.calls().filter((call) => call.method === "account/rateLimitResetCredit/consume");
  assert.equal(consumes.length, 2);
  const [a, b] = consumes.map((call) => call.params as Record<string, string>);
  assert.equal(a!.idempotencyKey, b!.idempotencyKey);
  assert.equal(a!.creditId, "soon");
  assert.equal(liveEmail(), "bob@x.com");
});

test("rename, remove, and config work and validate input", () => {
  threeAccounts();
  assert.equal(box.cdx(["rename", "bob", "robert"]).status, 0);
  assert.match(box.cdx(["list"]).stdout, /robert/);
  assert.equal(box.cdx(["remove", "ann", "--yes"]).status, 1);
  assert.equal(box.cdx(["remove", "cat"]).status, 1);
  assert.match(box.cdx(["remove", "ca", "--yes"]).stderr, /exactly/);
  assert.equal(box.cdx(["remove", "cat", "--yes"]).status, 0);
  assert.doesNotMatch(box.cdx(["list"]).stdout, /cat/);
  assert.equal(box.cdx(["config", "ssh-host", "my-host"]).status, 0);
  assert.match(box.cdx(["config"]).stdout, /ssh-host\s+my-host/);
  assert.equal(box.cdx(["config", "ssh-host", "bad host;rm"]).status, 1);
  assert.equal(box.cdx(["config", "codex-path", "relative/codex"]).status, 1);
});

test("unknown commands and options give a clear error", () => {
  const result = box.cdx(["resum"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command "resum"/);
  assert.match(box.cdx(["rank", "--jsn"]).stderr, /unknown option --jsn/);
});

test("doctor passes on a healthy setup", () => {
  threeAccounts();
  const result = box.cdx(["doctor"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /3 saved accounts; signed in as ann/);
});

test("cdx alone starts Codex with the arguments given", () => {
  threeAccounts();
  const result = box.cdx(["--version-of-codex-is-not-a-thing"]);
  // The fake Codex exits 2 for arguments it does not know; cdx passes that through.
  assert.equal(result.status, 2);
});

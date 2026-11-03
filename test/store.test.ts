import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CdxError } from "../src/files.js";
import { Paths, Store, UnreadableLiveLogin } from "../src/store.js";
import { apiKeyAuth, bytes, chatgptAuth, type Sandbox, sandbox } from "./helpers.js";

let box: Sandbox;
let store: Store;

beforeEach(() => {
  box = sandbox();
  store = new Store(new Paths(box.env));
});
afterEach(() => box.cleanup());

const quiet = <T>(fn: () => Promise<T>) => {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return fn().finally(() => { process.stderr.write = write; });
};

test("a login made outside cdx is saved as a new account, not overwritten", async () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com" }));
  const account = await quiet(() => store.locked(() => store.reconcile()));
  assert.equal(account?.alias, "ann");
  assert.equal(store.accounts().length, 1);
  assert.equal(store.activeId(), account?.id);
});

test("vault folders are private and logins are written 0600", async () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com" }));
  const account = (await quiet(() => store.locked(() => store.reconcile())))!;
  assert.equal(fs.statSync(store.paths.dataHome).mode & 0o777, 0o700);
  assert.equal(fs.statSync(account.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(account.dir, "auth.json")).mode & 0o777, 0o600);
});

test("the live login always wins, and an unexpectedly newer vault copy is backed up first", async () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-2", refreshed: "2026-10-02T00:00:00Z" }));
  const account = (await quiet(() => store.locked(() => store.reconcile())))!;
  fs.writeFileSync(path.join(account.dir, "auth.json"),
    JSON.stringify(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-from-the-future", refreshed: "2030-01-01T00:00:00Z" })));
  box.writeLive(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-3", refreshed: "2026-10-03T00:00:00Z" }));
  await quiet(() => store.locked(() => store.reconcile()));
  const saved = JSON.parse(fs.readFileSync(path.join(account.dir, "auth.json"), "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-3");
  const backups = fs.readdirSync(store.paths.backups);
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(store.paths.backups, backups[0]!), "utf8"), /rt-from-the-future/);
});

test("switching saves the outgoing login, then writes the new one", async () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com" }));
  const ann = (await quiet(() => store.locked(() => store.reconcile())))!;
  const bob = await store.locked(() => store.add(bytes(chatgptAuth({ email: "bob@x.com" }))));
  box.writeLive(chatgptAuth({ email: "ann@x.com", refreshToken: "rt-ann-newest", refreshed: "2026-10-05T00:00:00Z" }));
  assert.equal(await store.locked(() => store.activate(bob)), true);
  assert.equal((box.readLive().tokens as Record<string, string>).refresh_token, "rt-bob@x.com-1");
  const annSaved = JSON.parse(fs.readFileSync(path.join(ann.dir, "auth.json"), "utf8"));
  assert.equal(annSaved.tokens.refresh_token, "rt-ann-newest");
  assert.equal(store.activeId(), bob.id);
  assert.equal(await store.locked(() => store.activate(bob)), false);
  assert.equal(fs.statSync(store.paths.liveAuth).mode & 0o777, 0o600);
});

test("a token refresh that lands after a switch is untangled", async () => {
  // Bob is chosen and live. Then a session still on Ann finishes a refresh and
  // writes Ann's tokens into Bob's file, keeping Bob's workspace field.
  const ann = await store.locked(() => store.add(bytes(chatgptAuth({ email: "ann@x.com", workspace: "w-ann" }))));
  const bob = await store.locked(() => store.add(bytes(chatgptAuth({ email: "bob@x.com", workspace: "w-bob" }))));
  await quiet(() => store.locked(() => store.activate(bob)));
  box.writeLive(chatgptAuth({ email: "ann@x.com", workspace: "w-ann", storedWorkspace: "w-bob", refreshToken: "rt-ann-rotated", refreshed: "2026-10-09T00:00:00Z" }));
  const live = await quiet(() => store.locked(() => store.reconcile()));
  assert.equal(live?.id, bob.id);
  assert.equal((box.readLive().tokens as Record<string, string>).refresh_token, "rt-bob@x.com-1");
  const annSaved = JSON.parse(fs.readFileSync(path.join(ann.dir, "auth.json"), "utf8"));
  assert.equal(annSaved.tokens.refresh_token, "rt-ann-rotated");
  assert.equal(annSaved.tokens.account_id, "w-ann");
});

test("personal and team workspaces of one email are saved separately", async () => {
  await store.locked(() => store.add(bytes(chatgptAuth({ email: "a@x.com", user: "u", workspace: "personal" }))));
  const team = await store.locked(() => store.add(bytes(chatgptAuth({ email: "a@x.com", user: "u", workspace: "team" }))));
  assert.equal(store.accounts().length, 2);
  assert.equal(team.alias, "a-2");
  assert.throws(() => store.add(bytes(chatgptAuth({ email: "a@x.com", user: "u", workspace: "team" }))), /already saved/);
});

test("an unreadable live login is backed up and can then be replaced", async () => {
  const ann = await store.locked(() => store.add(bytes(chatgptAuth({ email: "ann@x.com" }))));
  fs.writeFileSync(store.paths.liveAuth, '{"future_format": "sk-keep-me"}');
  await assert.rejects(quiet(() => store.locked(() => store.reconcile())), UnreadableLiveLogin);
  assert.equal(await quiet(() => store.locked(() => store.activate(ann))), true);
  const backup = fs.readdirSync(store.paths.backups).find((name) => name.startsWith("unreadable-auth-"))!;
  assert.match(fs.readFileSync(path.join(store.paths.backups, backup), "utf8"), /sk-keep-me/);
});

test("a login Codex is in the middle of rewriting is read again, not replaced", async () => {
  const { spawn } = await import("node:child_process");
  fs.writeFileSync(store.paths.liveAuth, "");
  const content = JSON.stringify(chatgptAuth({ email: "ann@x.com" }));
  const writer = spawn(process.execPath, ["-e",
    `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(store.paths.liveAuth)}, ${JSON.stringify(content)}), 120)`]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const account = await quiet(() => store.locked(() => store.reconcile()));
  await new Promise((resolve) => writer.once("exit", resolve));
  assert.equal(account?.alias, "ann");
  assert.equal(fs.existsSync(store.paths.backups), false);
});

test("a symlinked live login is refused rather than followed", async () => {
  const elsewhere = path.join(box.root, "elsewhere.json");
  fs.writeFileSync(elsewhere, JSON.stringify(chatgptAuth({ email: "ann@x.com" })));
  fs.symlinkSync(elsewhere, store.paths.liveAuth);
  await assert.rejects(quiet(() => store.locked(() => store.reconcile())), /symbolic link/);
});

test("accounts resolve by alias, email, rank number, and unique partial match", async () => {
  const ann = await store.locked(() => store.add(bytes(chatgptAuth({ email: "ann@x.com" }))));
  const bob = await store.locked(() => store.add(bytes(chatgptAuth({ email: "bob@x.com" }))));
  await store.locked(() => store.add(bytes(chatgptAuth({ email: "bobby@x.com" }))));
  store.saveRank([bob, ann]);
  assert.equal(store.resolve("ann").id, ann.id);
  assert.equal(store.resolve("ANN@x.com").id, ann.id);
  assert.equal(store.resolve("2").id, ann.id);
  assert.equal(store.resolve("bob").id, bob.id);
  assert.throws(() => store.resolve("bo"), /more than one/);
  assert.throws(() => store.resolve("9"), /no account #9/);
  assert.throws(() => store.resolve("zed"), /no saved account/);
});

test("aliases are validated", async () => {
  await store.locked(() => store.add(bytes(chatgptAuth({ email: "ann@x.com" }))));
  for (const bad of ["", "123", "best", "has space", "../x", "-x", "a".repeat(41), "Ann"]) {
    assert.throws(() => store.validateAlias(bad), CdxError, bad);
  }
  store.validateAlias("work.team_2");
});

test("the signed-in account cannot be removed; others can", async () => {
  box.writeLive(chatgptAuth({ email: "ann@x.com" }));
  const ann = (await quiet(() => store.locked(() => store.reconcile())))!;
  const bob = await store.locked(() => store.add(bytes(chatgptAuth({ email: "bob@x.com" }))));
  assert.throws(() => store.remove(ann), /signed in/);
  store.remove(bob);
  assert.deepEqual(store.accounts().map((a) => a.alias), ["ann"]);
  assert.throws(() => store.resolveExact("an"), /no saved account is exactly/);
  assert.equal(store.resolveExact("ann@x.com").id, ann.id);
});

test("API key logins are saved and matched without storing the key twice", async () => {
  box.writeLive(apiKeyAuth("sk-test-key"));
  const account = (await quiet(() => store.locked(() => store.reconcile())))!;
  assert.equal(account.method, "apikey");
  assert.equal(account.alias, "api-key");
  const meta = fs.readFileSync(path.join(account.dir, "account.json"), "utf8");
  assert.ok(!meta.includes("sk-test-key"));
  assert.equal(store.liveAccount()?.id, account.id);
});

test("leftover temporary files from a killed command are cleaned up", () => {
  const old = path.join(store.paths.codexHome, ".auth.json.0123456789abcdef.tmp");
  const fresh = path.join(store.paths.codexHome, ".auth.json.fedcba9876543210.tmp");
  const unrelated = path.join(store.paths.codexHome, "notes.tmp");
  for (const file of [old, fresh, unrelated]) fs.writeFileSync(file, "x");
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(unrelated, past, past);
  store.cleanup();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(unrelated), true);
});

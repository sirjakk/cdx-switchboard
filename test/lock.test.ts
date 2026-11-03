import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withLock } from "../src/lock.js";

const LOCK_MODULE = fileURLToPath(new URL("../src/lock.js", import.meta.url));

function holder(file: string, ms: number) {
  const code = `const { withLock } = await import(${JSON.stringify(LOCK_MODULE)});
await withLock(${JSON.stringify(file)}, async () => { console.log("held"); await new Promise((r) => setTimeout(r, ${ms})); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  return { child, held };
}

test("the lock is exclusive across processes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-lock-"));
  const file = path.join(dir, "test.lock");
  const { child, held } = holder(file, 1500);
  await held;
  await assert.rejects(withLock(file, () => "never", { waitMs: 0, busyMessage: "busy" }), /busy/);
  const started = Date.now();
  assert.equal(await withLock(file, () => "after", { waitMs: 10_000 }), "after");
  assert.ok(Date.now() - started > 300);
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a crashed holder never leaves a stale lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-lock-"));
  const file = path.join(dir, "test.lock");
  const { child, held } = holder(file, 60_000);
  await held;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(await withLock(file, () => "free", { waitMs: 0 }), "free");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the lock is re-entrant within one process and released after errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-lock-"));
  const file = path.join(dir, "test.lock");
  const inner = await withLock(file, () => withLock(file, () => "nested", { waitMs: 0 }), { waitMs: 0 });
  assert.equal(inner, "nested");
  await assert.rejects(withLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withLock(file, () => "again", { waitMs: 0 }), "again");
  fs.rmSync(dir, { recursive: true, force: true });
});

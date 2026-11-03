import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callbackEndpoint, codexEnvironment, findCodex, shortError } from "../src/codex.js";
import { logPath, performHandoff } from "../src/handoff.js";
import type { T3 } from "../src/t3.js";
import { tunnelCommand } from "../src/tunnel.js";
import { compareVersions, installation } from "../src/update.js";
import { withEnv } from "./helpers.js";

function fakeT3(initially: boolean, { failStop = false, neverStops = false } = {}) {
  const events: string[] = [];
  let running = initially;
  const t3: T3 = {
    name: "fake T3",
    running: () => running,
    stop() {
      events.push("stop");
      if (failStop) throw new Error("quit refused");
      if (!neverStops) running = false;
    },
    start() {
      events.push("start");
      running = true;
    },
  };
  return { t3, events };
}

const tempData = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-handoff-"));
  fs.chmodSync(dir, 0o700);
  return dir;
};

test("handoff stops T3, switches, verifies, and starts T3 again", async () => {
  const data = tempData();
  const { t3, events } = fakeT3(true);
  await performHandoff(data, {
    t3, change: async () => { events.push("change"); return "switched"; }, verify: async () => { events.push("verify"); },
  }, { settleMs: 0, timeoutMs: 1000 });
  assert.deepEqual(events, ["stop", "change", "verify", "start"]);
  assert.match(fs.readFileSync(logPath(data), "utf8"), /done/);
  assert.equal(fs.statSync(logPath(data)).mode & 0o777, 0o600);
});

test("T3 is started again even when the switch fails", async () => {
  const data = tempData();
  const { t3, events } = fakeT3(true);
  await assert.rejects(performHandoff(data, {
    t3, change: async () => { throw new Error("no such account"); }, verify: async () => {},
  }, { settleMs: 0, timeoutMs: 1000 }), /no such account/);
  assert.deepEqual(events, ["stop", "start"]);
});

test("T3 is started again even if stopping it timed out", async () => {
  const data = tempData();
  const { t3, events } = fakeT3(true, { neverStops: true });
  await assert.rejects(performHandoff(data, { t3, change: async () => "x", verify: async () => {} }, { settleMs: 0, timeoutMs: 300 }), /did not stop/);
  assert.deepEqual(events, ["stop", "start"]);
});

test("a closed T3 stays closed", async () => {
  const data = tempData();
  const { t3, events } = fakeT3(false);
  await performHandoff(data, { t3, change: async () => "x", verify: async () => {} }, { settleMs: 0 });
  assert.deepEqual(events, []);
});

test("only one handoff runs at a time", async () => {
  const data = tempData();
  const { t3 } = fakeT3(false);
  let release!: () => void;
  const first = performHandoff(data, { t3, change: () => new Promise((resolve) => { release = () => resolve("x"); }), verify: async () => {} }, { settleMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The lock is re-entrant within a process, so check from a second process.
  const { spawnSync } = await import("node:child_process");
  const handoff = new URL("../src/handoff.js", import.meta.url).pathname;
  const other = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { ensureIdle } = await import(${JSON.stringify(handoff)}); try { await ensureIdle(${JSON.stringify(data)}); console.log("idle"); } catch (e) { console.log(e.message); }`], { encoding: "utf8" });
  assert.match(other.stdout, /another switch is in progress/);
  release();
  await first;
});

test("the login callback is read only from a localhost redirect_uri", () => {
  const url = (redirect: string) => `open https://auth.openai.com/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=1`;
  assert.deepEqual(callbackEndpoint(url("http://localhost:1455/auth/callback")), ["localhost", 1455]);
  assert.deepEqual(callbackEndpoint(url("http://[::1]:7000/cb")), ["::1", 7000]);
  assert.equal(callbackEndpoint(url("https://evil.example/cb")), undefined);
  assert.equal(callbackEndpoint(url("http://user:pw@localhost:1455/cb")), undefined);
  assert.equal(callbackEndpoint("Starting local login server on http://localhost:1455."), undefined);
});

test("tunnel commands use the SSH connection, a configured host, and bracket IPv6", () => {
  const user = os.userInfo().username;
  assert.equal(tunnelCommand("localhost", 1455, {}, { SSH_CONNECTION: "1.2.3.4 5 10.0.0.9 22" }),
    `ssh -o ExitOnForwardFailure=yes -N -L localhost:1455:localhost:1455 ${user}@10.0.0.9`);
  assert.equal(tunnelCommand("127.0.0.1", 1455, { ssh_host: "me@box" }, { SSH_CONNECTION: "1.2.3.4 5 10.0.0.9 2200" }),
    "ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:1455:127.0.0.1:1455 me@box");
  assert.match(tunnelCommand("::1", 1455, {}, { SSH_CONNECTION: "fe80::1 5 fe80::2 22" }), /-L '\[::1\]:1455:\[::1\]:1455' '\S+@\[fe80::2\]'$/);
});

test("Codex never gets token-redirecting variables; probes drop ambient keys", async () => {
  await withEnv({ CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://127.0.0.1:9/steal", OPENAI_API_KEY: "sk-x", CODEX_SQLITE_HOME: "/x" }, () => {
    const env = codexEnvironment("/home/codex");
    assert.equal(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, undefined);
    assert.equal(env.OPENAI_API_KEY, "sk-x");
    assert.equal(env.CODEX_HOME, "/home/codex");
    const probe = codexEnvironment("/vault/a", { probe: true });
    assert.equal(probe.OPENAI_API_KEY, undefined);
    assert.equal(probe.CODEX_SQLITE_HOME, undefined);
  });
});

test("Codex lookup skips relative PATH entries and cdx's own launchers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-find-"));
  const launcher = path.join(dir, "launcher", "codex");
  const real = path.join(dir, "real", "codex");
  const local = path.join(dir, "codex");
  for (const [file, body] of [[launcher, "#!/bin/sh\n# codex-switchboard launcher\n"], [real, "#!/bin/sh\n"], [local, "#!/bin/sh\n"]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o755 });
  }
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await withEnv({ PATH: `.::${path.dirname(launcher)}:${path.dirname(real)}`, CDX_CODEX_BIN: "", HOME: dir }, () => {
      delete process.env.CDX_CODEX_BIN;
      assert.equal(findCodex(), real);
    });
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex errors are shortened and response bodies dropped", () => {
  assert.equal(shortError("unexpected status 500 body={\"token\":\"x\"}\nmore"), "unexpected status 500");
});

test("versions compare like semver", () => {
  assert.ok(compareVersions("0.163.0", "0.164.0") < 0);
  assert.ok(compareVersions("0.164.0", "0.164.0-alpha.2") > 0);
  assert.ok(compareVersions("0.164.0-alpha.10", "0.164.0-alpha.2") > 0);
  assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0);
});

test("the install method is recognised from where Codex lives", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-npm-"));
  const pkg = path.join(prefix, "lib", "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.symlinkSync(path.join(pkg, "bin", "codex.js"), path.join(prefix, "bin", "codex"));
  const found = installation(path.join(prefix, "bin", "codex"));
  assert.equal(found.kind, "npm");
  assert.equal(found.prefix, fs.realpathSync(prefix));
  assert.equal(installation("/opt/homebrew/Caskroom/codex/0.1/codex").kind, "homebrew");
  fs.rmSync(prefix, { recursive: true, force: true });
});

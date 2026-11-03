// Test fixtures: fake logins, a fake Codex CLI, and isolated homes.
// Nothing here touches the real ~/.codex, cdx data, or T3.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../src/bin.js", import.meta.url));

export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

export interface FakeLogin {
  email: string;
  user?: string;
  workspace?: string;
  plan?: string;
  refreshed?: string;
  refreshToken?: string;
  /** Write a different workspace into tokens.account_id than the tokens claim. */
  storedWorkspace?: string;
}

export function chatgptAuth(login: FakeLogin): Record<string, unknown> {
  const user = login.user ?? `user-${login.email}`;
  const workspace = login.workspace ?? `ws-${login.email}`;
  const claim = { chatgpt_user_id: user, chatgpt_account_id: workspace, chatgpt_plan_type: login.plan ?? "plus" };
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ sub: user, email: login.email, "https://api.openai.com/auth": claim, iat: 1_700_000_000 }),
      access_token: jwt({ sub: user, "https://api.openai.com/auth": claim, iat: 1_700_000_000 }),
      refresh_token: login.refreshToken ?? `rt-${login.email}-1`,
      account_id: login.storedWorkspace ?? workspace,
    },
    last_refresh: login.refreshed ?? "2026-10-01T00:00:00.000000000Z",
  };
}

export function apiKeyAuth(key: string): Record<string, unknown> {
  return { auth_mode: "apikey", OPENAI_API_KEY: key };
}

export function bytes(auth: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(auth, null, 2));
}

const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const log = (entry) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const fixtures = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_FIXTURES, "utf8")); } catch { return {}; } };
const auth = () => JSON.parse(fs.readFileSync(home + "/auth.json", "utf8"));
const who = () => {
  const a = auth();
  if (a.OPENAI_API_KEY) return "apikey";
  return JSON.parse(Buffer.from(a.tokens.id_token.split(".")[1], "base64url")).email;
};
if (args[0] === "--version") { console.log("codex-cli " + (fixtures().version || "0.163.0")); process.exit(0); }
if (args[0] === "login") {
  log({ cmd: "login", args, home });
  console.log("Starting local login server on http://localhost:1455.");
  console.log("https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=x");
  const source = process.env.FAKE_LOGIN_AUTH;
  if (!source) process.exit(1);
  fs.copyFileSync(source, home + "/auth.json");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const f = fixtures();
  let email;
  try { email = who(); } catch { email = null; }
  log({ method: message.method, params: message.params, home, email, args });
  let result, error;
  const limits = (f.limits || {})[email] || {};
  const refreshed = fs.existsSync(home + "/refreshed");
  switch (message.method) {
    case "initialize": result = { userAgent: "fake", codexHome: home }; break;
    case "account/read":
      if (message.params && message.params.refreshToken) {
        if (limits.expired) { error = { message: "refresh_token_reused" }; break; }
        fs.writeFileSync(home + "/refreshed", "1");
        const a = auth();
        a.tokens.refresh_token = a.tokens.refresh_token + "-rotated";
        a.last_refresh = new Date().toISOString();
        fs.writeFileSync(home + "/auth.json", JSON.stringify(a));
      }
      result = { account: f.accountRead || (email === "apikey" ? { type: "apiKey" } : { type: "chatgpt", email, planType: "plus" }), requiresOpenaiAuth: true };
      break;
    case "account/rateLimits/read":
      if (limits.expired || (limits.needsRefresh && !refreshed)) { error = { message: "401 Unauthorized body={secret}" }; break; }
      if (limits.error) { error = { message: limits.error }; break; }
      result = limits.response || { rateLimits: { planType: "plus", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000000000 } } };
      break;
    case "account/rateLimitResetCredit/consume": {
      const consume = (f.consume || {})[email] || {};
      if (consume.error) { error = { message: consume.error }; break; }
      result = { outcome: consume.outcome || "reset" };
      break;
    }
    default: error = { message: "unknown method" };
  }
  process.stdout.write(JSON.stringify(error ? { id: message.id, error } : { id: message.id, result }) + "\n");
});
rl.on("close", () => process.exit(0));
`;

export interface Sandbox {
  root: string;
  dataHome: string;
  codexHome: string;
  codex: string;
  fixtures: string;
  log: string;
  env: NodeJS.ProcessEnv;
  setFixtures(value: unknown): void;
  calls(): Record<string, unknown>[];
  writeLive(auth: Record<string, unknown>): void;
  readLive(): Record<string, unknown>;
  cdx(args: string[], extra?: { env?: NodeJS.ProcessEnv; input?: string }): { status: number | null; stdout: string; stderr: string };
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-test-"));
  const dataHome = path.join(root, "data");
  const codexHome = path.join(root, "codex-home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(bin);
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, FAKE_CODEX, { mode: 0o755 });
  const fixtures = path.join(root, "fixtures.json");
  const log = path.join(root, "calls.log");
  fs.writeFileSync(fixtures, "{}");
  // T3 control is off so tests can never stop or start a real T3.
  fs.mkdirSync(dataHome, { mode: 0o700 });
  fs.writeFileSync(path.join(dataHome, "config.json"), JSON.stringify({ version: 2, t3: false }));
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    CDX_SWITCHBOARD_HOME: dataHome,
    CODEX_HOME: codexHome,
    CDX_CODEX_BIN: codex,
    T3CODE_HOME: path.join(root, "t3"),
    FAKE_FIXTURES: fixtures,
    FAKE_LOG: log,
    DISPLAY: ":0",
  };
  return {
    root, dataHome, codexHome, codex, fixtures, log, env,
    setFixtures: (value) => fs.writeFileSync(fixtures, JSON.stringify(value)),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    writeLive: (auth) => fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 }),
    readLive: () => JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")),
    cdx(args, extra = {}) {
      const result = spawnSync(process.execPath, [BIN, ...args], {
        env: { ...env, ...extra.env }, input: extra.input ?? "", encoding: "utf8", timeout: 60_000,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Run fn with process.env pointed at a sandbox, for in-process tests. */
export async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T> | T): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

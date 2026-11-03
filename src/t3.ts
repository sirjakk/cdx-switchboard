// T3 Code: find it, stop it, start it, and read its Codex settings.
//
// A running Codex keeps the account it started with, so T3 must restart to
// pick up a switch. On macOS T3 is the desktop app; on Linux it is the user
// service T3 installs (t3code.service, which config.json can change).

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isObject, readJson } from "./files.js";
import type { Config } from "./store.js";

const DEFAULT_BUNDLE_ID = "com.t3tools.t3code";
// The main T3 process in any install location, stable or Nightly, but not its helpers.
const MAC_PROCESS = String.raw`/T3 Code( \([A-Za-z]+\))?\.app/Contents/MacOS/T3 Code( \([A-Za-z]+\))?( |$)`;
const DEFAULT_SERVICE = "t3code.service";

export interface T3 {
  /** How T3 is identified, for messages. */
  name: string;
  running(): boolean;
  stop(): void;
  start(): void;
}

function run(command: string, args: string[], timeout = 15_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Wait until T3 reaches the wanted state. Throws on timeout. */
export function waitFor(t3: T3, wanted: boolean, timeoutMs = 60_000, pollMs = 250): void {
  const deadline = Date.now() + timeoutMs;
  while (t3.running() !== wanted) {
    if (Date.now() >= deadline) throw new Error(`T3 did not ${wanted ? "start" : "stop"} within ${timeoutMs / 1000}s`);
    sleep(pollMs);
  }
}

function macApp(): T3 {
  // The .app bundle of the T3 that is running, so cdx quits and reopens that
  // exact app (stable or Nightly, wherever it is installed).
  let app: string | undefined;
  const bundleId = () => {
    const id = app ? run("/usr/bin/defaults", ["read", path.join(app, "Contents", "Info"), "CFBundleIdentifier"]).stdout : "";
    // The id is placed inside an AppleScript string; accept only safe characters.
    return /^[A-Za-z0-9.-]+$/.test(id) ? id : DEFAULT_BUNDLE_ID;
  };
  return {
    name: "the T3 app",
    running() {
      // -a: macOS pgrep skips its own ancestors otherwise, and cdx run from a
      // T3 thread is a descendant of T3.
      const found = run("/usr/bin/pgrep", ["-a", "-U", String(process.getuid!()), "-lf", MAC_PROCESS]);
      if (!found.ok) return false;
      app = /^\d+ (\/.*?\.app)\/Contents\/MacOS\//m.exec(found.stdout)?.[1] ?? app;
      return true;
    },
    stop() {
      if (!run("/usr/bin/osascript", ["-e", `tell application id "${bundleId()}" to quit`], 30_000).ok) throw new Error("could not quit T3");
    },
    start() {
      if (!run("/usr/bin/open", app ? [app] : ["-b", DEFAULT_BUNDLE_ID]).ok) throw new Error("could not open T3");
    },
  };
}

function userService(unit: string): T3 {
  const safe = /^[A-Za-z0-9@._-]+\.service$/.test(unit) ? unit : DEFAULT_SERVICE;
  const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args], 60_000);
  return {
    name: `the ${safe} user service`,
    running: () => systemctl("show", safe, "--property=ActiveState", "--value").stdout === "active",
    stop() {
      if (!systemctl("stop", safe).ok) throw new Error(`systemctl could not stop ${safe}`);
    },
    start() {
      if (!systemctl("start", safe).ok) throw new Error(`systemctl could not start ${safe}`);
    },
  };
}

export function t3(config: Config): T3 | undefined {
  if (config.t3 === false) return undefined;
  if (process.platform === "darwin") return macApp();
  if (process.platform === "linux") return userService(config.t3_service ?? DEFAULT_SERVICE);
  return undefined;
}

/** True only if T3 is known to be running. Never throws. */
export function t3Running(config: Config): boolean {
  try {
    return t3(config)?.running() ?? false;
  } catch {
    return false;
  }
}

// Settings ----------------------------------------------------------------

export function settingsPath(): string {
  return path.join(process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"), "userdata", "settings.json");
}

/** T3's Codex provider settings, if T3 is installed and configured for Codex. */
export function codexSettings(): Record<string, unknown> | undefined {
  let settings: unknown;
  try {
    settings = readJson(settingsPath());
  } catch {
    return undefined;
  }
  if (!isObject(settings)) return undefined;
  const instances = isObject(settings.providerInstances) ? settings.providerInstances : {};
  const instance = isObject(instances.codex) ? instances.codex : undefined;
  if (instance) return isObject(instance.config) ? instance.config : {};
  const providers = isObject(settings.providers) ? settings.providers : {};
  return isObject(providers.codex) ? providers.codex : undefined;
}

/** The Codex binary T3 is configured to run, if it is an absolute path. */
export function t3CodexBinary(): string | undefined {
  const binary = codexSettings()?.binaryPath;
  return typeof binary === "string" && path.isAbsolute(binary) ? binary : undefined;
}

/** Problems that stop cdx switches from reaching T3. */
export function settingsProblems(codexHome: string): string[] {
  const settings = codexSettings();
  if (!settings) return [];
  const problems: string[] = [];
  for (const key of ["homePath", "shadowHomePath"]) {
    const value = settings[key];
    if (typeof value === "string" && value && path.resolve(value.replace(/^~(?=$|\/)/, os.homedir())) !== codexHome) {
      problems.push(`T3 runs Codex with its own home (${key}: ${value}); cdx switches ${codexHome}`);
    }
  }
  const binary = settings.binaryPath;
  if (typeof binary === "string" && path.basename(binary) === "cdx-codex") {
    problems.push("T3 still runs Codex through cdx-codex from cdx 0.2; set T3's Codex binary to the real codex");
  }
  return problems;
}

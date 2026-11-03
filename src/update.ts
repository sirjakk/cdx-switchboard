// Update the Codex CLI that cdx uses.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CdxError, isObject } from "./files.js";

export interface Installation {
  kind: "npm" | "homebrew" | "standalone" | "unknown";
  /** npm global prefix, for npm installations. */
  prefix?: string;
  hint: string;
}

/** Work out how a Codex binary was installed from where its real file lives. */
export function installation(binary: string): Installation {
  let real: string;
  try {
    real = fs.realpathSync(binary);
  } catch {
    real = binary;
  }
  const marker = `${path.sep}node_modules${path.sep}@openai${path.sep}codex${path.sep}`;
  const at = real.indexOf(marker);
  if (at >= 0) {
    const root = real.slice(0, at + marker.length - 1);
    let name: unknown;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      name = isObject(meta) ? meta.name : undefined;
    } catch {
      name = undefined;
    }
    // A global install lives in <prefix>/lib/node_modules.
    const lib = real.slice(0, at);
    if (name === "@openai/codex" && path.basename(lib) === "lib") {
      return { kind: "npm", prefix: path.dirname(lib), hint: "npm install -g @openai/codex@latest" };
    }
  }
  if (real.includes("/Caskroom/")) return { kind: "homebrew", hint: "brew upgrade --cask codex" };
  if (real.includes("/Cellar/")) return { kind: "homebrew", hint: "brew upgrade codex" };
  if (real.includes(`${path.sep}packages${path.sep}standalone${path.sep}`)) {
    return { kind: "standalone", hint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" };
  }
  return { kind: "unknown", hint: "update Codex the way you installed it" };
}

export function latestVersion(): string {
  const npm = spawnSync("npm", ["view", "@openai/codex@latest", "version", "--json", "--prefer-online"], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
  });
  if (npm.error || npm.status !== 0) throw new CdxError("could not ask npm for the latest Codex version");
  let value: unknown;
  try {
    value = JSON.parse(npm.stdout);
  } catch {
    throw new CdxError("npm returned an unexpected version");
  }
  if (Array.isArray(value)) value = value.at(-1);
  if (typeof value !== "string") throw new CdxError("npm returned an unexpected version");
  return value;
}

/** Compare two versions like 0.163.0 or 0.164.0-alpha.2. Negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
    if (!match) throw new CdxError(`not a version: ${version}`);
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (np && nq) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Install the latest Codex into the same npm prefix. */
export function npmUpdate(install: Installation): void {
  if (install.kind !== "npm" || !install.prefix) {
    throw new CdxError(`this Codex was not installed with npm; to update it, run: ${install.hint}`);
  }
  const result = spawnSync("npm", ["install", "-g", "--prefix", install.prefix, "@openai/codex@latest"], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new CdxError("npm could not update Codex; see its message above");
}

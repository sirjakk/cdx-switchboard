// Everything cdx asks of the installed Codex CLI.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { CdxError, isObject } from "./files.js";
import { VERSION } from "./version.js";

const FILE_STORE = 'cli_auth_credentials_store="file"';

/** Marker in cdx's own launchers, so cdx never mistakes itself for Codex. */
export const LAUNCHER_MARKER = "codex-switchboard launcher";

// Variables that redirect where Codex sends tokens, or replace the login cdx
// chose. They are removed for every Codex process cdx starts for an account.
const TOKEN_REDIRECTS = [
  "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE", "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
  "CDX_MANAGED_RUNTIME", "CDX_ORIGINAL_REFRESH_URL", "CDX_ORIGINAL_REVOKE_URL",
];
const AMBIENT_CREDENTIALS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];

/** The login could not be recovered; the user must sign in again. */
export class LoginExpired extends CdxError {}

export function codexEnvironment(codexHome?: string, { probe = false } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (codexHome) env.CODEX_HOME = codexHome;
  for (const name of TOKEN_REDIRECTS) delete env[name];
  if (probe) {
    for (const name of AMBIENT_CREDENTIALS) delete env[name];
    delete env.CODEX_SQLITE_HOME;
  }
  return env;
}

function isLauncher(file: string): boolean {
  if (path.basename(file) === "cdx-codex") return true;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(4096);
      const text = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString("latin1");
      return text.includes(LAUNCHER_MARKER) || text.includes("cdx_switchboard");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** An absolute path to an executable that is not one of cdx's own launchers. */
export function isRealCodex(file: string): boolean {
  return path.isAbsolute(file) && executable(file) && !isLauncher(fs.realpathSync(file));
}

/** Every absolute `codex` on PATH. Relative entries (like "." or "") are skipped on purpose. */
export function codexesOnPath(searchPath = process.env.PATH ?? ""): string[] {
  return searchPath.split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "codex"))
    .filter((file) => executable(file) && !isLauncher(fs.realpathSync(file)));
}

/**
 * The real Codex executable: CDX_CODEX_BIN, then the configured path, then
 * PATH, then the fallbacks (such as the Codex T3 runs), then common folders.
 */
export function findCodex(configured?: string, fallbacks: (string | undefined)[] = []): string {
  const home = os.homedir();
  const candidates = [
    process.env.CDX_CODEX_BIN, configured, ...codexesOnPath(), ...fallbacks,
    ...["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")]
      .map((dir) => path.join(dir, "codex")),
  ];
  for (const candidate of candidates) if (candidate && isRealCodex(candidate)) return candidate;
  throw new CdxError("cannot find the Codex CLI; install it (npm install -g @openai/codex) or set CDX_CODEX_BIN");
}

export function authError(message: string): boolean {
  return /401|unauthorized|token_revoked|token_expired|refresh_token_(reused|expired|invalidated)|sign(ing)? in again|log in again|not logged in|not authenticated|authentication required/i
    .test(message);
}

/** Keep a Codex error short and free of response bodies. */
export function shortError(message: string): string {
  return message.split("body=")[0]!.replace(/\s+/g, " ").trim().slice(0, 200);
}

interface Response {
  id?: number;
  result?: unknown;
  error?: { message?: string } | string;
}

function errorText(response: Response): string {
  const { error } = response;
  return shortError(typeof error === "string" ? error : error?.message ?? "Codex returned an error");
}

export interface QueryOptions {
  timeoutMs?: number;
  /** Read the login exactly as other Codex processes would (no file-store override). */
  asConfigured?: boolean;
}

export class Codex {
  constructor(readonly binary: string) {}

  version(): string {
    const result = spawnSync(this.binary, ["--version"], { encoding: "utf8", timeout: 10_000, env: codexEnvironment() });
    const line = result.stdout?.trim().split("\n")[0] ?? "";
    if (result.status !== 0 || !line.startsWith("codex-cli ")) throw new CdxError(`could not run ${this.binary} --version`);
    return line.slice("codex-cli ".length);
  }

  rateLimits(codexHome: string): Promise<Record<string, unknown>> {
    return this.query(codexHome, "account/rateLimits/read", undefined, { timeoutMs: 20_000 });
  }

  /** Which account a fresh Codex process signs in as. Never refreshes tokens. */
  readAccount(codexHome: string): Promise<Record<string, unknown>> {
    return this.query(codexHome, "account/read", { refreshToken: false }, { asConfigured: true });
  }

  consumeReset(codexHome: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.query(codexHome, "account/rateLimitResetCredit/consume", params, { timeoutMs: 30_000 });
  }

  /** One request to `codex app-server` running on the given Codex home. */
  async query(codexHome: string, method: string, params?: Record<string, unknown>,
    options: QueryOptions = {}): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const args = ["app-server", ...(options.asConfigured ? [] : ["-c", FILE_STORE])];
    const child = spawn(this.binary, args, { env: codexEnvironment(codexHome, { probe: true }), stdio: ["pipe", "pipe", "ignore"] });
    const pending = new Map<number, (response: Response) => void>();
    let failure: Error | undefined;
    const failAll = (error: Error) => {
      failure ??= error;
      for (const resolve of pending.values()) resolve({ error: failure.message });
      pending.clear();
    };
    child.on("error", (error) => failAll(new CdxError(`could not start Codex: ${error.message}`)));
    child.on("close", (code) => failAll(new CdxError(`Codex app-server exited (${code ?? "signal"})`)));
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (isObject(message) && typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)!(message as Response);
        pending.delete(message.id);
      }
    });
    let nextId = 1;
    const send = (payload: Record<string, unknown>) => child.stdin.write(JSON.stringify(payload) + "\n");
    const request = (requestMethod: string, requestParams?: unknown) => new Promise<Response>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdxError(`Codex did not answer ${requestMethod} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      send({ id, method: requestMethod, params: requestParams ?? null });
    });

    try {
      const init = await request("initialize", { clientInfo: { name: "codex-switchboard", title: "cdx", version: VERSION } });
      if (init.error) throw new CdxError(`Codex app-server did not start: ${errorText(init)}`);
      send({ method: "initialized" });
      let response = await request(method, params);
      if (response.error && method !== "account/read" && authError(errorText(response))) {
        // The usage endpoint can reject a cached access token without
        // refreshing it. Ask Codex to refresh once, then retry.
        const refreshed = await request("account/read", { refreshToken: true });
        if (refreshed.error) {
          if (authError(errorText(refreshed))) throw new LoginExpired("login expired or was revoked");
          throw new CdxError(`token refresh failed: ${errorText(refreshed)}`);
        }
        if (!isObject(refreshed.result) || refreshed.result.account == null) throw new LoginExpired("login expired or was revoked");
        response = await request(method, params);
      }
      if (response.error) {
        const message = errorText(response);
        throw authError(message) ? new LoginExpired("login expired or was revoked") : new CdxError(message);
      }
      if (!isObject(response.result)) throw new CdxError(`Codex returned no data for ${method}`);
      return response.result;
    } finally {
      await stop(child);
    }
  }

  /**
   * Run `codex login` in a private staging home and return the new auth.json.
   * The staging home starts empty, so Codex has no previous login to revoke.
   */
  async login(stagingHome: string, mode: "browser" | "device" | "apikey",
    onCallback?: (host: string, port: number) => void): Promise<Buffer> {
    const args = ["login", ...(mode === "device" ? ["--device-auth"] : mode === "apikey" ? ["--with-api-key"] : []), "-c", FILE_STORE];
    const env = codexEnvironment(stagingHome);
    const watch = mode === "browser" && onCallback !== undefined;
    const child = spawn(this.binary, args, { env, stdio: ["inherit", watch ? "pipe" : "inherit", watch ? "pipe" : "inherit"] });
    if (watch) {
      const seen = new Set<string>();
      for (const stream of [child.stdout!, child.stderr!]) {
        createInterface({ input: stream }).on("line", (line) => {
          process.stdout.write(line + "\n");
          const endpoint = callbackEndpoint(line);
          if (endpoint && !seen.has(endpoint.join(":"))) {
            seen.add(endpoint.join(":"));
            onCallback!(...endpoint);
          }
        });
      }
    }
    const interrupt = () => child.kill("SIGINT");
    process.on("SIGINT", interrupt);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", (error) => reject(new CdxError(`could not start codex login: ${error.message}`)));
        child.on("exit", (status) => resolve(status));
      });
      if (code !== 0) throw new CdxError(code === null ? "login was cancelled" : `codex login failed (exit ${code})`);
    } finally {
      process.off("SIGINT", interrupt);
    }
    const auth = path.join(stagingHome, "auth.json");
    if (!fs.existsSync(auth)) throw new CdxError("codex login finished without saving a login");
    return fs.readFileSync(auth);
  }
}

/** The localhost OAuth callback in a printed authorization URL, if any. */
export function callbackEndpoint(line: string): [string, number] | undefined {
  for (const url of line.match(/https?:\/\/[^\s\x1b"'<>]+/g) ?? []) {
    let redirect: string | null;
    try {
      redirect = new URL(url).searchParams.get("redirect_uri");
    } catch {
      continue;
    }
    if (!redirect) continue;
    try {
      const target = new URL(redirect);
      const host = target.hostname.replace(/^\[|\]$/g, "");
      if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(host)) continue;
      if (target.username || target.password) continue;
      const port = Number(target.port || 80);
      if (port >= 1 && port <= 65535) return [host, port];
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Close app-server politely and give it time: it may be saving a refresh
 * token that the server has already rotated, and killing it then would lose
 * the login. Signals are only a last resort.
 */
async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
  child.stdin?.end();
  if (await within(15_000)) return;
  child.kill("SIGTERM");
  if (await within(5_000)) return;
  child.kill("SIGKILL");
  await within(1000);
}

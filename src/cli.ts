// The cdx command line.
//
// Every Codex process on a computer uses one Codex home. cdx changes which
// saved account that home is signed in as, so threads keep their history
// across switches. store.ts explains how logins are kept safe.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseLogin } from "./auth.js";
import { Codex, codexEnvironment, codexesOnPath, findCodex, isRealCodex, LoginExpired } from "./codex.js";
import { CdxError, ensurePrivateDir, isObject } from "./files.js";
import { ensureIdle, logPath, performHandoff, scheduleHelper } from "./handoff.js";
import { autoPick, emptyUsage, parseUsage, rankAccounts, renderTable, toJson, type Usage, usable } from "./ranking.js";
import { consumeReset } from "./reset.js";
import { type Account, type Config, label, Store, UnreadableLiveLogin } from "./store.js";
import { settingsProblems, t3, t3CodexBinary, t3Running } from "./t3.js";
import { printTunnelHelp, remoteSession } from "./tunnel.js";
import { compareVersions, installation, latestVersion, npmUpdate } from "./update.js";
import { VERSION } from "./version.js";

const MIN_CODEX = "0.100.0";

const HELP = `cdx ${VERSION}: switch the Codex CLI between your accounts without losing thread history.

Usage: cdx <command> [options]

  rank [--json]              usage left on every account, best first
  switch [account]           switch Codex to an account (default: the best one); restarts T3 if it is running
  use <account>              switch Codex without restarting T3
  restart                    restart T3 so it picks up the current account
  list                       saved accounts (no network)
  current                    the account Codex is signed in as
  login [--device | --with-api-key] [--alias <name>]
                             sign in to an account, save it, and switch to it
  relogin [account] [--device]
                             sign in again to a saved account whose login expired
  repair [--device]          sign in again to every account whose login expired
  reset [account]            use a usage reset credit, then switch to that account
  rename <account> <alias>   rename a saved account
  remove <account> [--yes]   delete a saved account from this computer
  import-current [alias]     save the login Codex is using now
  update [--check]           update the Codex CLI (npm installs) and restart T3
  config [<key> [<value> | --unset]]
                             show or change settings: codex-path, ssh-host, t3, t3-service
  doctor                     check that everything is set up correctly
  cdx [codex options]        start Codex, like running codex

An account is an alias, an email, or a number from the last \`cdx rank\`.
Docs: https://www.npmjs.com/package/codex-switchboard`;

// Arguments ---------------------------------------------------------------

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parse(args: string[], allowed: Record<string, "flag" | "value">): Args {
  const result: Args = { positional: [], flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      result.positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      result.positional.push(arg);
      continue;
    }
    const [name, inline] = arg.replace(/^--?/, "").split(/=(.*)/s, 2) as [string, string | undefined];
    const kind = allowed[name];
    if (!kind) throw new CdxError(`unknown option ${arg}; see \`cdx --help\``);
    if (kind === "flag") {
      result.flags.set(name, true);
    } else {
      const value = inline ?? args[++i];
      if (value === undefined) throw new CdxError(`${arg} needs a value`);
      result.flags.set(name, value);
    }
  }
  return result;
}

function atMost(args: Args, count: number, usage: string): void {
  if (args.positional.length > count) throw new CdxError(`usage: cdx ${usage}`);
}

// Shared steps --------------------------------------------------------------

class App {
  readonly store = new Store();
  private codexInstance?: Codex;

  get codex(): Codex {
    this.codexInstance ??= new Codex(findCodex(this.store.config().codex_binary, [t3CodexBinary()]));
    return this.codexInstance;
  }

  get config(): Config {
    return this.store.config();
  }

  /** Refuse to change logins when Codex keeps them somewhere other than auth.json. */
  requireFileStore(): void {
    const store = codexSetting(this.store.paths.codexHome, "cli_auth_credentials_store");
    if (store && store !== "file") {
      throw new CdxError(`Codex keeps logins in "${store}" storage (cli_auth_credentials_store in `
        + `${path.join(this.store.paths.codexHome, "config.toml")}). cdx switches accounts through auth.json; `
        + `set cli_auth_credentials_store = "file" there, sign in again with \`cdx login\`, then retry.`);
    }
  }

  async reconcile(): Promise<Account | undefined> {
    return this.store.locked(async () => {
      try {
        return await this.store.reconcile();
      } catch (error) {
        if (!(error instanceof UnreadableLiveLogin)) throw error;
        warn(error.message);
        return undefined;
      }
    });
  }

  /** One account's usage, read through its newest login. Call inside locked(), after reconcile. */
  async usage(account: Account, liveId: string | undefined): Promise<Usage> {
    if (account.method !== "chatgpt") return emptyUsage(account);
    const response = await this.store.accountLocked(account, () => this.codex.rateLimits(this.store.probeHome(account, liveId)));
    return parseUsage(account, response);
  }

  async rank(): Promise<Usage[]> {
    return this.store.locked(async () => {
      // No fallback here: if the live login cannot be read, probing the live
      // account through its older vault copy could replay a rotated token.
      const liveId = (await this.store.reconcile())?.id;
      const accounts = this.store.accounts();
      if (!accounts.length) throw new CdxError("no accounts saved yet; run `cdx login`");
      const rows = await rankAccounts(accounts, (account) => this.usage(account, liveId));
      this.store.saveRank(rows.map((row) => row.account));
      return rows;
    });
  }

  /** The account a selector names; "best" or nothing ranks first. */
  async target(selector: string | undefined, { defaultBest = true } = {}): Promise<{ account: Account; checked: boolean }> {
    if (selector === "best" || (selector === undefined && defaultBest)) {
      const best = (await this.rank()).find(autoPick);
      if (!best) throw new CdxError("no ChatGPT account has usage left; run `cdx rank` for details");
      return { account: best.account, checked: true };
    }
    await this.reconcile();
    return { account: this.store.resolve(selector), checked: false };
  }

  /** Refuse to switch to an account that cannot be used right now. */
  async requireUsable(account: Account): Promise<void> {
    if (account.method !== "chatgpt") return;
    let usage: Usage;
    try {
      usage = await this.store.locked(async () => this.usage(account, (await this.store.reconcile())?.id));
    } catch (error) {
      if (error instanceof LoginExpired) {
        throw new CdxError(`the login for ${account.alias} expired; run \`cdx relogin ${account.alias}\`. Nothing was changed`);
      }
      throw new CdxError(`could not check ${account.alias}: ${(error as Error).message}. Nothing was changed`);
    }
    if (!usable(usage)) {
      throw new CdxError(`${account.alias} has no usage left; nothing was changed. Run \`cdx rank\`, or \`cdx switch\` for the best account`);
    }
  }

  /** Throw unless a fresh Codex process signs in as the account. */
  async verify(account: Account): Promise<void> {
    if (this.store.liveAccount()?.id !== account.id) throw new CdxError(`Codex's login is not ${account.alias}`);
    if (account.method === "other") return;
    const result = await this.codex.readAccount(this.store.paths.codexHome);
    const actual = isObject(result.account) ? result.account : {};
    const ok = account.method === "apikey" ? actual.type === "apiKey"
      : actual.type === "chatgpt" && (!account.email || String(actual.email ?? "").toLowerCase() === account.email.toLowerCase());
    if (!ok) throw new CdxError(`Codex does not sign in as ${account.alias}`);
  }

  async switchNow(account: Account): Promise<boolean> {
    return this.store.locked(() => this.store.activate(account));
  }

  /**
   * Refuse to switch if Codex does not read its login from auth.json (for
   * example keyring storage set by a profile or managed settings): replacing
   * the file would change nothing.
   */
  async requireCodexReadsAuthFile(): Promise<void> {
    const live = this.store.liveAccount();
    if (!live || live.method === "other") return;
    let actual: Record<string, unknown> = {};
    try {
      const result = await this.codex.readAccount(this.store.paths.codexHome);
      actual = isObject(result.account) ? result.account : {};
    } catch {
      return; // Could not ask; the check after switching still applies.
    }
    const matches = live.method === "apikey" ? actual.type === "apiKey"
      : actual.type === "chatgpt" && (!live.email || String(actual.email ?? "").toLowerCase() === live.email.toLowerCase());
    if (!matches) {
      throw new CdxError(`Codex is not using ${this.store.paths.liveAuth} for its login (it may keep logins in the `
        + "system keyring through a profile or managed settings), so switching would have no effect. See `cdx doctor`.");
    }
  }

  helperEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env, CDX_CODEX_BIN: this.codex.binary, CODEX_HOME: this.store.paths.codexHome,
      CDX_SWITCHBOARD_HOME: this.store.paths.dataHome,
    };
  }

  scheduleT3Helper(helper: string, args: string[]): void {
    scheduleHelper(helper, args, this.helperEnvironment(), process.platform === "linux");
  }
}

function warn(message: string): void {
  process.stderr.write(`cdx: ${message}\n`);
}

/** A top-level string setting from Codex's config.toml, if set. */
export function codexSetting(codexHome: string, key: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = new RegExp(`^\\s*["']?${key}["']?\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const RESUME_NOTE = "Codex sessions already open in a terminal stay on their account; exit and run `codex resume` to continue them on this one.";

// Commands ------------------------------------------------------------------

async function cmdList(app: App): Promise<void> {
  const live = await app.reconcile();
  const accounts = app.store.accounts();
  if (!accounts.length) {
    console.log("No accounts saved yet. Run `cdx login`.");
    return;
  }
  const width = Math.max(...accounts.map((account) => account.alias.length));
  for (const account of accounts) {
    const kind = account.method === "chatgpt" ? account.email ?? "ChatGPT" : account.method === "apikey" ? "API key" : "other login";
    console.log(`${account.id === live?.id ? "*" : " "} ${account.alias.padEnd(width)}  ${kind}${account.plan ? `  (${account.plan})` : ""}`);
  }
  if (live) console.log("\n* signed in now");
}

async function cmdCurrent(app: App): Promise<void> {
  const live = await app.reconcile();
  if (!live) throw new CdxError("Codex is not signed in to a saved account; run `cdx use <account>` or `cdx login`");
  console.log(`${live.alias}\t${live.email ?? live.method}`);
}

async function cmdRank(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  const rows = await app.rank();
  const liveId = app.store.liveAccount()?.id;
  console.log(args.flags.has("json") ? JSON.stringify(toJson(rows, liveId), null, 2) : renderTable(rows, liveId));
}

async function cmdUse(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  let selector = args.positional[0];
  if (selector === undefined) {
    if (!process.stdin.isTTY) throw new CdxError("usage: cdx use <account>");
    console.log(renderTable(await app.rank(), app.store.liveAccount()?.id));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    selector = (await prompt.question("\nAccount to use (number or alias, blank to cancel): ")).trim();
    prompt.close();
    if (!selector) return console.log("Cancelled.");
  }
  const { account, checked } = await app.target(selector);
  if (!checked) await app.requireUsable(account);
  await app.requireCodexReadsAuthFile();
  const changed = await app.switchNow(account);
  if (!changed) return console.log(`Codex already uses ${label(account)}.`);
  await app.verify(account);
  console.log(`Codex on this computer now uses ${label(account)}.`);
  console.log(RESUME_NOTE);
  if (t3Running(app.config)) console.log("T3 keeps its previous account until it restarts; run `cdx restart` when ready.");
}

async function cmdSwitch(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  const { account, checked } = await app.target(args.positional[0]);
  if (app.store.liveAccount()?.id === account.id) {
    console.log(`Codex already uses ${label(account)}.`);
    if (t3Running(app.config)) console.log("If T3 started before that, run `cdx restart` so it uses this account too.");
    return;
  }
  if (!checked) await app.requireUsable(account);
  await app.requireCodexReadsAuthFile();
  const control = t3(app.config);
  if (!control || !t3Running(app.config)) {
    await app.switchNow(account);
    await app.verify(account);
    console.log(`Codex on this computer now uses ${label(account)}.`);
    console.log(RESUME_NOTE);
    return;
  }
  await ensureIdle(app.store.paths.dataHome);
  app.scheduleT3Helper("_switch-helper", [account.id]);
  console.log(`Switching to ${label(account)}. T3 will restart in a few seconds.`);
  console.log("Threads keep their history: reopen a thread after T3 reconnects and say \"continue\".");
  console.log(`Progress: ${logPath(app.store.paths.dataHome)}`);
}

async function cmdRestart(app: App): Promise<void> {
  if (!t3Running(app.config)) return console.log("T3 is not running; it will use the current account when it starts.");
  await ensureIdle(app.store.paths.dataHome);
  app.scheduleT3Helper("_restart-t3", []);
  console.log("T3 will restart in a few seconds. Reopen your thread after it reconnects.");
  console.log(`Progress: ${logPath(app.store.paths.dataHome)}`);
}

async function signIn(app: App, mode: "browser" | "device" | "apikey"): Promise<Buffer> {
  const staging = fs.mkdtempSync(path.join(ensurePrivateDir(path.join(app.store.paths.dataHome, ".staging")), "login-"));
  try {
    const config = app.config;
    const help = mode === "browser" && remoteSession(config)
      ? (host: string, port: number) => printTunnelHelp(host, port, config) : undefined;
    if (mode === "apikey" && process.stdin.isTTY) console.log("Paste the API key, then press Enter and Ctrl-D:");
    return await app.codex.login(staging, mode, help);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function loginMode(args: Args): "browser" | "device" | "apikey" {
  if (args.flags.has("device") && args.flags.has("with-api-key")) throw new CdxError("choose either --device or --with-api-key");
  return args.flags.has("device") ? "device" : args.flags.has("with-api-key") ? "apikey" : "browser";
}

async function cmdLogin(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  atMost(args, 0, "login [--device | --with-api-key] [--alias <name>]");
  const alias = args.flags.get("alias") as string | undefined;
  if (alias !== undefined) app.store.validateAlias(alias);
  const bytes = await signIn(app, loginMode(args));
  const account = await app.store.locked(async () => {
    await app.reconcile();
    const existing = app.store.find(parseLogin(bytes).login);
    let saved = existing ? await app.store.accountLocked(existing, () => app.store.replace(existing, bytes)) : app.store.add(bytes, alias);
    if (existing) {
      app.store.writeLiveIfCurrent(saved);
      if (alias !== undefined && alias !== saved.alias) saved = app.store.rename(saved, alias);
    }
    await app.store.activate(saved);
    return saved;
  });
  console.log(`Signed in. Codex on this computer now uses ${label(account)}.`);
  if (t3Running(app.config)) console.log("T3 keeps its previous account until it restarts; run `cdx restart` when ready.");
}

async function relogin(app: App, account: Account, mode: "browser" | "device" | "apikey"): Promise<void> {
  console.log(`Signing in again to ${label(account)}...`);
  const bytes = await signIn(app, account.method === "apikey" ? "apikey" : mode);
  await app.store.locked(async () => {
    await app.reconcile();
    const current = app.store.resolve(account.id);
    const updated = await app.store.accountLocked(current, () => app.store.replace(current, bytes));
    app.store.writeLiveIfCurrent(updated);
  });
  console.log(`Updated the login for ${account.alias}.`);
}

async function cmdRelogin(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  atMost(args, 1, "relogin [account] [--device]");
  await app.reconcile();
  await relogin(app, app.store.resolve(args.positional[0]), loginMode(args));
}

async function cmdRepair(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  const expired = (await app.rank()).filter((row) => row.expired);
  if (!expired.length) return console.log("Every saved login works.");
  for (const row of expired) await relogin(app, row.account, loginMode(args));
}

async function cmdReset(app: App, args: Args): Promise<void> {
  app.requireFileStore();
  atMost(args, 1, "reset [account]");
  await app.reconcile();
  const account = app.store.resolve(args.positional[0]);
  if (account.method !== "chatgpt") throw new CdxError("reset credits belong to ChatGPT accounts");
  await consumeReset(app.store, app.codex, account);
  console.log(`Used a reset credit; ${account.alias} has usage again.`);
  if (app.store.liveAccount()?.id === account.id) return;
  try {
    await cmdSwitch(app, { positional: [account.id], flags: new Map() });
  } catch (error) {
    throw new CdxError(`the reset worked, but switching failed (${(error as Error).message}); `
      + `run \`cdx switch ${account.alias}\` to retry without spending another credit`);
  }
}

async function cmdRename(app: App, args: Args): Promise<void> {
  if (args.positional.length !== 2) throw new CdxError("usage: cdx rename <account> <new-alias>");
  await app.reconcile();
  const account = await app.store.locked(() => app.store.rename(app.store.resolve(args.positional[0]), args.positional[1]!));
  console.log(`Renamed to ${account.alias}.`);
}

async function cmdRemove(app: App, args: Args): Promise<void> {
  if (args.positional.length !== 1) throw new CdxError("usage: cdx remove <account> [--yes]");
  await app.reconcile();
  const account = app.store.resolveExact(args.positional[0]!);
  if (!args.flags.has("yes")) {
    if (!process.stdin.isTTY) throw new CdxError("add --yes to remove an account without a prompt");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question(`Remove ${label(account)} from this computer? [y/N] `)).trim().toLowerCase();
    prompt.close();
    if (answer !== "y" && answer !== "yes") return console.log("Cancelled.");
  }
  await app.store.locked(() => app.store.remove(account));
  console.log(`Removed ${account.alias}. Its login still works elsewhere; sign out on the web to end it everywhere.`);
}

async function cmdImport(app: App, args: Args): Promise<void> {
  atMost(args, 1, "import-current [alias]");
  let live = await app.reconcile();
  if (!live) throw new CdxError(`Codex is not signed in (${app.store.paths.liveAuth} is missing)`);
  const alias = args.positional[0];
  if (alias && alias !== live.alias) live = await app.store.locked(() => app.store.rename(live!, alias));
  console.log(`The current Codex login is saved as ${live.alias}.`);
}

async function cmdUpdate(app: App, args: Args): Promise<void> {
  const before = app.codex.version();
  const install = installation(app.codex.binary);
  const latest = latestVersion();
  console.log(`Installed: ${before}\nLatest:    ${latest}`);
  const behind = compareVersions(before, latest) < 0;
  if (args.flags.has("check")) {
    return console.log(behind ? `An update is available. Run \`cdx update\`${install.kind === "npm" ? "" : ` or: ${install.hint}`}.` : "Codex is up to date.");
  }
  if (!behind) return console.log("Codex is up to date.");
  npmUpdate(install);
  const after = app.codex.version();
  if (after === before) return console.log("Codex did not change.");
  console.log(`Updated Codex ${before} -> ${after}.`);
  console.log("Codex sessions already open in a terminal keep the old version until you exit and run `codex resume`.");
  if (t3Running(app.config)) {
    await ensureIdle(app.store.paths.dataHome);
    app.scheduleT3Helper("_restart-t3", []);
    console.log(`T3 will restart in a few seconds to use it. Progress: ${logPath(app.store.paths.dataHome)}`);
  }
}

const CONFIG_KEYS: Record<string, keyof Config> = {
  "codex-path": "codex_binary", "ssh-host": "ssh_host", t3: "t3", "t3-service": "t3_service",
};

async function cmdConfig(app: App, args: Args): Promise<void> {
  const [name, value] = args.positional;
  if (!name) {
    const config = app.config;
    for (const [key, field] of Object.entries(CONFIG_KEYS)) console.log(`${key.padEnd(13)} ${config[field] ?? "(default)"}`);
    return;
  }
  const field = CONFIG_KEYS[name];
  if (!field) throw new CdxError(`unknown setting ${name}; settings are ${Object.keys(CONFIG_KEYS).join(", ")}`);
  if (args.flags.has("unset")) {
    app.store.setConfig({ [field]: undefined });
    return console.log(`${name} reset to the default.`);
  }
  if (value === undefined) return console.log(app.config[field] ?? "(default)");
  let parsed: string | boolean = value;
  if (field === "t3") {
    if (!["on", "off", "true", "false"].includes(value)) throw new CdxError("t3 is on or off");
    parsed = value === "on" || value === "true";
  } else if (field === "codex_binary") {
    if (!path.isAbsolute(value) || !isRealCodex(value)) throw new CdxError("codex-path must be the absolute path of the Codex CLI");
  } else if (field === "t3_service" ? !/^[A-Za-z0-9@._-]+\.service$/.test(value) : !/^[A-Za-z0-9@._:-]+$/.test(value)) {
    throw new CdxError(field === "t3_service" ? "t3-service must be a unit name like t3code.service" : `${name} contains characters that are not allowed`);
  }
  app.store.setConfig({ [field]: parsed });
  console.log(`${name} = ${parsed}`);
}

async function cmdDoctor(app: App): Promise<number> {
  let errors = 0;
  const report = (level: "ok" | "warn" | "error", message: string) => {
    if (level === "error") errors++;
    console.log(`${{ ok: "ok   ", warn: "WARN ", error: "ERROR" }[level]} ${message}`);
  };
  report("ok", `cdx ${VERSION} on Node ${process.versions.node} (${process.platform})`);
  const paths = app.store.paths;
  report("ok", `cdx data: ${paths.dataHome}`);
  report("ok", `Codex home: ${paths.codexHome}${process.env.CODEX_HOME ? " (from CODEX_HOME)" : ""}`);

  try {
    const version = app.codex.version();
    const old = compareVersions(version, MIN_CODEX) < 0;
    report(old ? "warn" : "ok", `Codex ${version} at ${app.codex.binary}${old ? `; update to ${MIN_CODEX} or newer` : ""}`);
    const real = (file: string) => { try { return fs.realpathSync(file); } catch { return file; } };
    const others = codexesOnPath().filter((file) => real(file) !== real(app.codex.binary));
    for (const other of new Set(others.map(real))) report("warn", `another Codex install on PATH: ${other}; use only one`);
  } catch (error) {
    report("error", (error as Error).message);
  }

  const store = codexSetting(paths.codexHome, "cli_auth_credentials_store");
  report(store && store !== "file" ? "error" : "ok",
    store && store !== "file" ? `Codex keeps logins in "${store}" storage; set cli_auth_credentials_store = "file" in config.toml` : "Codex keeps its login in auth.json");
  if (/^\s*\[profiles\.[\s\S]*cli_auth_credentials_store/m.test(readText(path.join(paths.codexHome, "config.toml")))) {
    report("warn", "a profile in config.toml sets cli_auth_credentials_store; cdx needs \"file\" for profiles you use too");
  }
  for (const key of ["forced_login_method", "forced_chatgpt_workspace_id"]) {
    const value = codexSetting(paths.codexHome, key);
    if (value) report("warn", `config.toml sets ${key} = "${value}"; accounts that do not match it cannot be used`);
  }

  try {
    const stat = fs.lstatSync(paths.liveAuth);
    if (stat.isSymbolicLink()) report("error", `${paths.liveAuth} is a symbolic link; cdx needs a regular file there`);
    else report((stat.mode & 0o077) === 0 ? "ok" : "warn", `login file permissions ${(stat.mode & 0o777).toString(8)}`);
  } catch {
    report("warn", "Codex is signed out; run `cdx use <account>` or `cdx login`");
  }
  const live = app.store.liveAccount();
  const accounts = app.store.accounts();
  report(accounts.length ? "ok" : "warn", `${plural(accounts.length, "saved account")}${live ? `; signed in as ${label(live)}` : ""}`);
  for (const account of accounts) {
    try {
      app.store.readLogin(account);
    } catch (error) {
      report("error", (error as Error).message);
    }
    if (fs.existsSync(path.join(account.dir, "pending-reset.json"))) {
      report("warn", `${account.alias} has an unconfirmed reset; run \`cdx reset ${account.alias}\` to finish it`);
    }
  }

  const config = app.config;
  if (config.t3 === false) {
    report("ok", "T3 restarts are turned off (cdx config t3 off)");
  } else {
    const control = t3(config);
    report("ok", control ? `T3: ${control.name} is ${t3Running(config) ? "running" : "not running"}` : "T3 is not supported on this system");
    for (const problem of settingsProblems(paths.codexHome)) report("error", problem);
  }
  return errors ? 1 : 0;
}

/** `cdx` alone, or with Codex options: start Codex on the live account. */
async function launch(app: App, args: string[]): Promise<number> {
  const live = await app.reconcile();
  if (!live && app.store.activeAccount()) {
    warn(`Codex is signed out. Run \`cdx use ${app.store.activeAccount()!.alias}\` to sign back in with the saved login.`);
  }
  const child = spawn(app.codex.binary, args, { stdio: "inherit", env: codexEnvironment(app.store.paths.codexHome) });
  const ignore = () => {};
  // Codex handles Ctrl-C itself. Ctrl-Z keeps its default, so the shell gets the terminal back.
  for (const signal of ["SIGINT", "SIGQUIT"] as const) process.on(signal, ignore);
  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(new CdxError(`could not start Codex: ${error.message}`)));
    child.on("exit", (code, signal) => resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 0)));
  });
}

// Detached helpers ----------------------------------------------------------

async function helper(app: App, name: string, args: string[]): Promise<void> {
  const control = t3(app.config);
  if (!control) throw new CdxError("T3 is not supported on this system");
  if (name === "_restart-t3") {
    await performHandoff(app.store.paths.dataHome, { t3: control, change: async () => "restarting T3 only", verify: async () => {} });
    return;
  }
  const account = app.store.accounts().find((candidate) => candidate.id === args[0]);
  if (!account) throw new CdxError("the account to switch to no longer exists");
  await performHandoff(app.store.paths.dataHome, {
    t3: control,
    change: async () => `${(await app.switchNow(account)) ? "switched" : "already switched"} to ${account.alias}`,
    verify: () => app.verify(account),
  });
}

// Entry point ---------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new CdxError("cdx supports macOS and Linux (on Windows, use WSL)");
  }
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  const app = new App();
  app.store.cleanup();
  if (command === "_switch-helper" || command === "_restart-t3") {
    await helper(app, command, rest);
    return 0;
  }
  if (command === undefined || command.startsWith("-")) return launch(app, argv);

  const options = {
    login: { device: "flag", "with-api-key": "flag", alias: "value" },
    relogin: { device: "flag" },
    repair: { device: "flag" },
    rank: { json: "flag" },
    update: { check: "flag" },
    remove: { yes: "flag" },
    config: { unset: "flag" },
  } as const satisfies Record<string, Record<string, "flag" | "value">>;
  const args = parse(rest, (options as Record<string, Record<string, "flag" | "value">>)[command] ?? {});
  switch (command) {
    case "list": case "ls": await cmdList(app); break;
    case "current": await cmdCurrent(app); break;
    case "rank": await cmdRank(app, args); break;
    case "use": await cmdUse(app, args); break;
    case "switch": atMost(args, 1, "switch [account]"); await cmdSwitch(app, args); break;
    case "restart": await cmdRestart(app); break;
    case "login": case "add": await cmdLogin(app, args); break;
    case "relogin": await cmdRelogin(app, args); break;
    case "repair": await cmdRepair(app, args); break;
    case "reset": await cmdReset(app, args); break;
    case "rename": await cmdRename(app, args); break;
    case "remove": case "rm": await cmdRemove(app, args); break;
    case "import-current": await cmdImport(app, args); break;
    case "update": await cmdUpdate(app, args); break;
    case "config": await cmdConfig(app, args); break;
    case "doctor": return cmdDoctor(app);
    default: throw new CdxError(`unknown command "${command}"; see \`cdx --help\` (to run Codex itself, use \`codex ${command}\`)`);
  }
  return 0;
}

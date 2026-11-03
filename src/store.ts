// Saved logins and the one live Codex login.
//
// Codex reads exactly one login: CODEX_HOME/auth.json. Every Codex process on
// this computer (terminal, T3, SSH) uses that same home, so thread history
// never moves and every thread can be resumed on every account.
//
// cdx keeps each account's login in a private vault and switches by atomically
// replacing the live file. Codex rotates refresh tokens, so for any account the
// most recently refreshed copy is the only valid one. Before every change cdx
// reconciles: the live copy, which Codex uses and refreshes, is saved to the
// vault, and the live file is only replaced if nothing changed it meanwhile.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Login, type Method, parseLogin, RESERVED_ALIASES, sameAccount, suggestAlias, unmix } from "./auth.js";
import { CdxError, atomicWrite, ensurePrivateDir, isObject, readJson, readPrivate, writeJson } from "./files.js";
import { withLock } from "./lock.js";

const ACCOUNT_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface Account {
  id: string;
  alias: string;
  email?: string;
  method: Method;
  workspace?: string;
  plan?: string;
  dir: string;
}

/** The live login cannot be parsed. A copy was kept, so replacing it is safe. */
export class UnreadableLiveLogin extends CdxError {}

/** Codex wrote the live login while cdx was about to replace it. */
class LiveChanged extends CdxError {}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.equals(b);
}

export function label(account: Account): string {
  const kind = account.method === "apikey" ? "API key" : account.method === "other" ? "other login" : "ChatGPT";
  return `${account.alias} (${account.email ?? kind})`;
}

function note(message: string): void {
  process.stderr.write(`cdx: ${message}\n`);
}

export interface Config {
  /** The Codex CLI to use when it is not found automatically. */
  codex_binary?: string;
  /** SSH host name the browser computer uses to reach this one, for login tunnels. */
  ssh_host?: string;
  /** Set to false if cdx should never stop or start T3. */
  t3?: boolean;
  t3_service?: string;
}

export class Paths {
  readonly dataHome: string;
  readonly codexHome: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const home = os.homedir();
    const expand = (value: string) => value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
    this.dataHome = path.resolve(expand(env.CDX_SWITCHBOARD_HOME
      || path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "cdx-switchboard")));
    this.codexHome = path.resolve(expand(env.CODEX_HOME || path.join(home, ".codex")));
  }

  get accounts() { return path.join(this.dataHome, "accounts"); }
  get active() { return path.join(this.dataHome, "active.json"); }
  get lastRank() { return path.join(this.dataHome, "last-rank.json"); }
  get config() { return path.join(this.dataHome, "config.json"); }
  get backups() { return path.join(this.dataHome, "backups"); }
  get lock() { return path.join(this.dataHome, "cdx.lock"); }
  get liveAuth() { return path.join(this.codexHome, "auth.json"); }
}

export function authPath(account: Account): string {
  return path.join(account.dir, "auth.json");
}

export class Store {
  readonly paths: Paths;

  constructor(paths = new Paths()) {
    this.paths = paths;
    ensurePrivateDir(paths.dataHome);
    ensurePrivateDir(paths.accounts);
  }

  /** Serialize every change to the vault and the live login. */
  locked<T>(fn: () => Promise<T> | T): Promise<T> {
    return withLock(this.paths.lock, fn, { waitingMessage: "cdx: waiting for another cdx command to finish..." });
  }

  /** Serialize cdx's own use of one account's tokens (usage checks, resets, relogin). */
  accountLocked<T>(account: Account, fn: () => Promise<T> | T): Promise<T> {
    return withLock(path.join(account.dir, "login.lock"), fn);
  }

  // Configuration ---------------------------------------------------------

  config(): Config {
    const value = readJson(this.paths.config);
    return isObject(value) ? value as Config : {};
  }

  setConfig(changes: Partial<Config>): void {
    const next: Record<string, unknown> = { version: 2, ...this.config(), ...changes };
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
    writeJson(this.paths.config, next);
  }

  // Accounts --------------------------------------------------------------

  private load(dir: string): Account | undefined {
    let meta: unknown;
    try {
      meta = readJson(path.join(dir, "account.json"));
    } catch {
      return undefined;
    }
    if (!isObject(meta) || typeof meta.id !== "string" || typeof meta.alias !== "string") return undefined;
    if (!fs.existsSync(path.join(dir, "auth.json"))) return undefined;
    return {
      id: meta.id,
      alias: meta.alias,
      email: typeof meta.email === "string" ? meta.email : undefined,
      method: meta.method === "api_key" || meta.method === "apikey" ? "apikey" : meta.method === "other" ? "other" : "chatgpt",
      workspace: typeof meta.workspace === "string" ? meta.workspace : undefined,
      plan: typeof meta.plan === "string" ? meta.plan : undefined,
      dir,
    };
  }

  accounts(): Account[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.accounts);
    } catch {
      return [];
    }
    return names
      .filter((name) => ACCOUNT_DIR.test(name))
      .map((name) => this.load(path.join(this.paths.accounts, name)))
      .filter((account): account is Account => account !== undefined && ACCOUNT_DIR.test(account.id))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  activeId(): string | undefined {
    try {
      const value = readJson(this.paths.active);
      return isObject(value) && typeof value.account_id === "string" ? value.account_id : undefined;
    } catch {
      return undefined;
    }
  }

  activeAccount(): Account | undefined {
    const id = this.activeId();
    return this.accounts().find((account) => account.id === id);
  }

  /** The saved login for an account. Throws if it is unreadable. */
  readLogin(account: Account): { bytes: Buffer; login: Login } {
    const bytes = readPrivate(authPath(account));
    if (!bytes) throw new CdxError(`the saved login for ${account.alias} is missing`);
    return { bytes, login: parseLogin(bytes, `the saved login for ${account.alias}`).login };
  }

  /** Find the saved account a login belongs to, preferring an exact workspace match. */
  find(login: Login): Account | undefined {
    const matches: { account: Account; exact: boolean }[] = [];
    for (const account of this.accounts()) {
      let saved: Login;
      try {
        saved = this.readLogin(account).login;
      } catch {
        continue;
      }
      if (sameAccount(saved, login)) matches.push({ account, exact: saved.workspace === login.workspace });
    }
    return (matches.find((match) => match.exact) ?? matches[0])?.account;
  }

  resolve(selector: string | undefined): Account {
    const accounts = this.accounts();
    if (!accounts.length) throw new CdxError("no accounts saved yet; run `cdx login`");
    if (!selector || selector === "active" || selector === "current" || selector === "live") {
      const live = this.liveAccount() ?? this.activeAccount();
      if (live) return live;
      throw new CdxError("Codex is not signed in to a saved account; name an account");
    }
    if (/^\d+$/.test(selector)) {
      const ranked = readJsonQuiet(this.paths.lastRank);
      const ids = isObject(ranked) && Array.isArray(ranked.account_ids) ? ranked.account_ids : [];
      const match = accounts.find((account) => account.id === ids[Number(selector) - 1]);
      if (match) return match;
      throw new CdxError(`no account #${selector} in the last ranking; run \`cdx rank\` first`);
    }
    const wanted = selector.toLowerCase();
    const exact = accounts.filter((account) =>
      [account.id, account.alias.toLowerCase(), account.email?.toLowerCase()].includes(wanted));
    if (exact.length === 1) return exact[0]!;
    const partial = exact.length ? exact : accounts.filter((account) =>
      account.alias.toLowerCase().includes(wanted) || Boolean(account.email?.toLowerCase().includes(wanted)));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) {
      throw new CdxError(`"${selector}" matches more than one account (${partial.map((a) => a.alias).join(", ")}); use an alias`);
    }
    throw new CdxError(`no saved account matches "${selector}"; run \`cdx list\``);
  }

  /** Only an exact alias, email, or id, for commands that delete things. */
  resolveExact(selector: string): Account {
    const wanted = selector.toLowerCase();
    const matches = this.accounts().filter((account) =>
      [account.id, account.alias.toLowerCase(), account.email?.toLowerCase()].includes(wanted));
    if (matches.length === 1) return matches[0]!;
    throw new CdxError(matches.length ? `"${selector}" matches more than one account; use its alias`
      : `no saved account is exactly "${selector}"; use an alias from \`cdx list\``);
  }

  validateAlias(alias: string, except?: Account): void {
    if (!ALIAS.test(alias) || /^\d+$/.test(alias) || RESERVED_ALIASES.has(alias.toLowerCase())) {
      throw new CdxError("an alias is 1-40 letters, digits, '.', '_' or '-', is not only digits, "
        + `and is not ${[...RESERVED_ALIASES].join(", ")}`);
    }
    if (this.accounts().some((account) => account.id !== except?.id && account.alias.toLowerCase() === alias.toLowerCase())) {
      throw new CdxError(`the alias ${alias} is already used`);
    }
  }

  /** Save a new login. Call inside locked(). */
  add(bytes: Buffer, alias?: string): Account {
    const { login } = parseLogin(bytes);
    const existing = this.find(login);
    if (existing) throw new CdxError(`this login is already saved as ${existing.alias}`);
    alias ??= suggestAlias(login, this.accounts().map((account) => account.alias));
    this.validateAlias(alias);
    const id = crypto.randomUUID();
    const dir = ensurePrivateDir(path.join(this.paths.accounts, id));
    const now = new Date().toISOString();
    atomicWrite(path.join(dir, "auth.json"), bytes);
    writeJson(path.join(dir, "account.json"), { id, alias, ...metadata(login), created_at: now, updated_at: now });
    return this.load(dir)!;
  }

  /** Replace an account's saved login with a newer copy of the same account. */
  replace(account: Account, bytes: Buffer): Account {
    const { login } = parseLogin(bytes);
    const saved = this.readLogin(account).login;
    if (!sameAccount(saved, login)) {
      throw new CdxError(`that login is a different account than ${account.alias}; use \`cdx login\` to add it`);
    }
    const meta = readJson(path.join(account.dir, "account.json"));
    atomicWrite(authPath(account), bytes);
    writeJson(path.join(account.dir, "account.json"), {
      ...(isObject(meta) ? meta : {}), ...metadata(login), updated_at: new Date().toISOString(),
    });
    return this.load(account.dir) ?? account;
  }

  rename(account: Account, alias: string): Account {
    this.validateAlias(alias, account);
    const meta = readJson(path.join(account.dir, "account.json"));
    writeJson(path.join(account.dir, "account.json"), { ...(isObject(meta) ? meta : {}), alias, updated_at: new Date().toISOString() });
    if (this.activeId() === account.id) this.markActive({ ...account, alias });
    return this.load(account.dir) ?? account;
  }

  /** Delete a saved login. The live login is never deleted. */
  remove(account: Account): void {
    if (this.liveAccount()?.id === account.id) {
      throw new CdxError(`${account.alias} is the account Codex is signed in as; switch to another account first`);
    }
    fs.rmSync(account.dir, { recursive: true, force: true });
    for (const name of safeList(this.paths.backups)) {
      if (name.startsWith(`vault-${account.id}-`)) fs.rmSync(path.join(this.paths.backups, name), { force: true });
    }
    if (this.activeId() === account.id) fs.rmSync(this.paths.active, { force: true });
  }

  saveRank(accounts: Account[]): void {
    writeJson(this.paths.lastRank, { account_ids: accounts.map((account) => account.id), saved_at: new Date().toISOString() });
  }

  private markActive(account: Account): void {
    writeJson(this.paths.active, { account_id: account.id, alias: account.alias, activated_at: new Date().toISOString() });
  }

  // The live login ----------------------------------------------------------

  /**
   * Read the live login. Codex rewrites it in place (truncate, then write), so
   * an empty or half-written file is read again for a moment before it counts
   * as unreadable.
   */
  private readLive(): { bytes: Buffer; auth: Record<string, unknown>; login: Login } | undefined {
    for (let attempt = 1; ; attempt++) {
      const bytes = readPrivate(this.paths.liveAuth);
      if (bytes === undefined) return undefined;
      try {
        if (bytes.length === 0) throw new CdxError(`${this.paths.liveAuth} is empty`);
        return { bytes, ...parseLogin(bytes, this.paths.liveAuth) };
      } catch (error) {
        if (attempt >= 6) throw error;
        sleep(60);
      }
    }
  }

  /** The bytes of the live login as last seen by reconcile. */
  private seenLive: Buffer | undefined;

  /**
   * Replace the live login, but only if it still holds what reconcile saw.
   * Otherwise a token Codex just wrote would be lost.
   */
  private writeLive(bytes: Buffer): void {
    if (!sameBytes(readPrivate(this.paths.liveAuth), this.seenLive)) throw new LiveChanged("Codex changed its login during the switch");
    fs.mkdirSync(this.paths.codexHome, { recursive: true, mode: 0o700 });
    atomicWrite(this.paths.liveAuth, bytes);
    this.seenLive = bytes;
  }

  /** The saved account Codex is signed in as, if any. Never throws. */
  liveAccount(): Account | undefined {
    try {
      const live = this.readLive();
      return live && !live.login.mixed ? this.find(live.login) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Where Codex should read an account's newest login: the live home for the
   * live account (its vault copy may hold an already rotated refresh token),
   * the vault folder for every other account. `liveId` comes from reconcile.
   */
  probeHome(account: Account, liveId: string | undefined): string {
    return account.id === liveId ? this.paths.codexHome : account.dir;
  }

  /**
   * Make the vault and the live login agree, and return the live account.
   * A login cdx has not seen (for example from `codex login`) is saved as a
   * new account, never overwritten. Call inside locked().
   */
  async reconcile(): Promise<Account | undefined> {
    let live: ReturnType<Store["readLive"]>;
    try {
      live = this.readLive();
    } catch (error) {
      if (!(error instanceof CdxError)) throw error;
      this.seenLive = readPrivateQuiet(this.paths.liveAuth);
      this.backupUnreadableLive();
      throw new UnreadableLiveLogin(`${error.message}; run \`cdx use <account>\` to replace it`);
    }
    this.seenLive = live?.bytes;
    if (!live) return undefined;
    if (live.login.mixed) return this.repairMixed(live.auth, live.login);
    const account = await this.saveLive(live.bytes, live.login);
    const previous = this.activeAccount();
    if (previous && previous.id !== account.id) {
      note(`Codex is signed in as ${account.alias}, not ${previous.alias}; something other than cdx changed it`);
    }
    if (this.activeId() !== account.id) this.markActive(account);
    return account;
  }

  /**
   * Save the live login to its vault entry. Codex uses and refreshes the live
   * copy, so it is the newest; the vault copy is only ever replaced by it.
   */
  private async saveLive(bytes: Buffer, login: Login): Promise<Account> {
    const found = this.find(login);
    if (!found) {
      const account = this.add(bytes);
      note(`saved the current Codex login as ${account.alias}`);
      return account;
    }
    return this.accountLocked(found, () => {
      const saved = this.readLogin(found);
      if (saved.bytes.equals(bytes)) return found;
      if ((saved.login.refreshedAt ?? 0) > (login.refreshedAt ?? 0)) {
        // Only a clock change or a restored backup makes the vault look newer.
        this.backup(`vault-${found.id}`, saved.bytes);
      }
      return this.replace(found, bytes);
    });
  }

  /**
   * A Codex session still on account A finished a token refresh just after a
   * switch to B, and Codex wrote A's new tokens into B's login file. Save A's
   * tokens to A, then restore the account the user chose.
   */
  private async repairMixed(auth: Record<string, unknown>, login: Login): Promise<Account> {
    const fixed = unmix(auth, login);
    const owner = await this.saveLive(fixed, parseLogin(fixed).login);
    const chosen = this.activeAccount() ?? owner;
    this.writeLive(chosen.id === owner.id ? fixed : this.readLogin(chosen).bytes);
    if (this.activeId() !== chosen.id) this.markActive(chosen);
    note(`a Codex session on ${owner.alias} refreshed its login during a switch; `
      + `saved it to ${owner.alias} and restored ${chosen.alias}`);
    return chosen;
  }

  /** Keep a private copy of a login, named by its content so repeats are not duplicated. */
  private backup(name: string, bytes: Buffer): string {
    ensurePrivateDir(this.paths.backups);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const file = path.join(this.paths.backups, `${name}-${digest}.json`);
    if (!fs.existsSync(file)) atomicWrite(file, bytes);
    return file;
  }

  /** Keep a copy of a live login cdx cannot parse before anything replaces it. */
  private backupUnreadableLive(): void {
    const bytes = readPrivateQuiet(this.paths.liveAuth);
    if (bytes?.length) note(`the Codex login could not be read; a copy is at ${this.backup("unreadable-auth", bytes)}`);
  }

  /** Remove temporary files left by a cdx command that was killed. */
  cleanup(): void {
    const now = Date.now();
    const stale = (file: string, age: number) => {
      try {
        if (now - fs.lstatSync(file).mtimeMs > age) fs.rmSync(file, { recursive: true, force: true });
      } catch {
        // Already gone.
      }
    };
    // atomicWrite's temporary files: ".<name>.<16 hex>.tmp".
    const temporary = /^\.[a-z-]+\.json\.[0-9a-f]{16}\.tmp$/;
    for (const dir of [this.paths.codexHome, this.paths.dataHome, ...this.accounts().map((account) => account.dir)]) {
      for (const name of safeList(dir)) if (temporary.test(name)) stale(path.join(dir, name), 10 * 60_000);
    }
    const staging = path.join(this.paths.dataHome, ".staging");
    for (const name of safeList(staging)) stale(path.join(staging, name), 24 * 3_600_000);
  }

  /**
   * Make an account the live Codex login. Returns true if the login changed.
   * Call inside locked().
   */
  async activate(account: Account): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      let current: Account | undefined;
      try {
        current = await this.reconcile();
      } catch (error) {
        // reconcile kept a copy of an unreadable live login; replacing it is safe.
        if (!(error instanceof UnreadableLiveLogin)) throw error;
      }
      if (current?.id === account.id) return false;
      try {
        await this.accountLocked(account, () => this.writeLive(this.readLogin(account).bytes));
      } catch (error) {
        if (!(error instanceof LiveChanged) || attempt >= 3) throw error;
        continue;
      }
      this.markActive(account);
      return true;
    }
  }

  /** After a new sign-in, push the login to Codex if that account is live. Call inside locked(). */
  writeLiveIfCurrent(account: Account): boolean {
    const live = readPrivateQuiet(this.paths.liveAuth);
    if (this.liveAccount()?.id !== account.id) return false;
    this.seenLive = live;
    this.writeLive(this.readLogin(account).bytes);
    return true;
  }
}

function metadata(login: Login): Record<string, unknown> {
  return { method: login.method, email: login.email, workspace: login.workspace, plan: login.plan };
}

function readJsonQuiet(file: string): unknown {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readPrivateQuiet(file: string): Buffer | undefined {
  try {
    return readPrivate(file);
  } catch {
    return undefined;
  }
}

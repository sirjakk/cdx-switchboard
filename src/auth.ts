// Read who a Codex login belongs to, without validating or exposing it.
//
// JWT claims are decoded only to tell saved logins apart. Codex itself does
// all authentication. Nothing here ever returns or prints a token.

import crypto from "node:crypto";
import { CdxError, isObject, parseJson } from "./files.js";

export type Method = "chatgpt" | "apikey" | "other";

export interface Login {
  /** "chatgpt" for a ChatGPT sign-in, "apikey" for an API key, "other" for any other credential. */
  method: Method;
  /** The person: ChatGPT user id or the token subject. */
  user?: string;
  /** The ChatGPT workspace. One person can have personal and team workspaces. */
  workspace?: string;
  email?: string;
  plan?: string;
  /** SHA-256 of a non-ChatGPT credential, so two can be compared without keeping a second copy. */
  keyHash?: string;
  /** When Codex last refreshed this login (ms since epoch), if known. */
  refreshedAt?: number;
  /**
   * The file's workspace field disagrees with its tokens. A Codex session that
   * was refreshing during a switch wrote its own tokens into the new login.
   */
  mixed?: boolean;
}

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

export function jwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") return {};
  const parts = token.split(".");
  if (parts.length < 3) return {};
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function issuedAt(claims: Record<string, unknown>): number | undefined {
  return typeof claims.iat === "number" ? claims.iat * 1000 : undefined;
}

/** Parse auth.json content. Throws CdxError, never echoing the content. */
export function parseLogin(data: Buffer | string, label = "the Codex login"): { auth: Record<string, unknown>; login: Login } {
  const auth = parseJson(data, label);
  if (!isObject(auth)) throw new CdxError(`${label} is not a Codex login`);
  return { auth, login: describeLogin(auth, label) };
}

export function describeLogin(auth: Record<string, unknown>, label = "the Codex login"): Login {
  const refreshed = Date.parse(String(auth.last_refresh ?? ""));
  const tokens = isObject(auth.tokens) ? auth.tokens : undefined;
  if (tokens && (tokens.refresh_token || tokens.access_token || tokens.id_token)) {
    const id = jwtClaims(tokens.id_token);
    const access = jwtClaims(tokens.access_token);
    const idAuth = isObject(id[AUTH_CLAIM]) ? id[AUTH_CLAIM] : {};
    const accessAuth = isObject(access[AUTH_CLAIM]) ? access[AUTH_CLAIM] : {};
    const profile = isObject(access[PROFILE_CLAIM]) ? access[PROFILE_CLAIM] : {};
    // The tokens say whose login this is; tokens.account_id is only a copy.
    const idWorkspace = text(idAuth.chatgpt_account_id);
    const accessWorkspace = text(accessAuth.chatgpt_account_id);
    if (idWorkspace && accessWorkspace && idWorkspace !== accessWorkspace) {
      throw new CdxError(`${label} holds tokens from two different accounts`);
    }
    const claimed = idWorkspace ?? accessWorkspace;
    const stored = text(tokens.account_id);
    return {
      method: "chatgpt",
      user: text(idAuth.chatgpt_user_id) ?? text(accessAuth.chatgpt_user_id) ?? text(idAuth.user_id)
        ?? text(accessAuth.user_id) ?? text(id.sub) ?? text(access.sub),
      workspace: claimed ?? stored,
      email: text(id.email) ?? text(profile.email),
      plan: text(idAuth.chatgpt_plan_type) ?? text(accessAuth.chatgpt_plan_type),
      refreshedAt: Number.isFinite(refreshed) ? refreshed : issuedAt(access) ?? issuedAt(id),
      mixed: Boolean(claimed && stored && claimed !== stored),
    };
  }
  const key = text(auth.OPENAI_API_KEY);
  const other = ["personal_access_token", "agent_identity", "bedrock_api_key", "bedrock_access_keys"]
    .map((field) => auth[field]).filter((value) => value !== undefined && value !== null);
  if (key || other.length) {
    return {
      method: key ? "apikey" : "other",
      keyHash: crypto.createHash("sha256").update(key ?? JSON.stringify(other)).digest("hex"),
      refreshedAt: Number.isFinite(refreshed) ? refreshed : undefined,
    };
  }
  throw new CdxError(`${label} has no Codex credentials`);
}

/** The login with its workspace field corrected to match its tokens. */
export function unmix(auth: Record<string, unknown>, login: Login): Buffer {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  return Buffer.from(JSON.stringify({ ...auth, tokens: { ...tokens, account_id: login.workspace } }, null, 2) + "\n");
}

/** True when two logins are the same ChatGPT workspace membership or the same API key. */
export function sameAccount(a: Login, b: Login): boolean {
  if (a.method !== b.method) return false;
  if (a.method !== "chatgpt") return a.keyHash !== undefined && a.keyHash === b.keyHash;
  const sameUser = a.user && b.user ? a.user === b.user
    : Boolean(a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase());
  if (!sameUser) return false;
  return !a.workspace || !b.workspace || a.workspace === b.workspace;
}

export const RESERVED_ALIASES = new Set(["best", "active", "current", "live"]);

/** A valid alias suggestion from the email, unique among `taken`. */
export function suggestAlias(login: Login, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  let base = (login.email?.split("@")[0] ?? (login.method === "apikey" ? "api-key" : login.method === "other" ? "login" : "account"))
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 28) || "account";
  if (/^\d+$/.test(base) || RESERVED_ALIASES.has(base)) base = `account-${base}`;
  let alias = base;
  for (let n = 2; used.has(alias.toLowerCase()); n++) alias = `${base}-${n}`;
  return alias;
}

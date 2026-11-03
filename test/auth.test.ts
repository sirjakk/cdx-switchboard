import assert from "node:assert/strict";
import { test } from "node:test";
import { describeLogin, parseLogin, sameAccount, suggestAlias, unmix } from "../src/auth.js";
import { CdxError } from "../src/files.js";
import { apiKeyAuth, bytes, chatgptAuth } from "./helpers.js";

test("reads who a ChatGPT login belongs to", () => {
  const login = describeLogin(chatgptAuth({ email: "Ann@Example.com", user: "u1", workspace: "w1", plan: "pro" }));
  assert.equal(login.method, "chatgpt");
  assert.equal(login.user, "u1");
  assert.equal(login.workspace, "w1");
  assert.equal(login.email, "Ann@Example.com");
  assert.equal(login.plan, "pro");
  assert.equal(login.mixed, false);
  assert.equal(login.refreshedAt, Date.parse("2026-10-01T00:00:00Z"));
});

test("one person's personal and team workspaces are different accounts", () => {
  const personal = describeLogin(chatgptAuth({ email: "a@x.com", user: "u1", workspace: "personal" }));
  const team = describeLogin(chatgptAuth({ email: "a@x.com", user: "u1", workspace: "team" }));
  const again = describeLogin(chatgptAuth({ email: "a@x.com", user: "u1", workspace: "personal", refreshToken: "other" }));
  assert.equal(sameAccount(personal, team), false);
  assert.equal(sameAccount(personal, again), true);
  assert.equal(sameAccount(personal, describeLogin(chatgptAuth({ email: "b@x.com", workspace: "personal" }))), false);
});

test("a file whose workspace field disagrees with its tokens is marked mixed and can be corrected", () => {
  const auth = chatgptAuth({ email: "a@x.com", workspace: "w-a", storedWorkspace: "w-b" });
  const login = describeLogin(auth);
  assert.equal(login.mixed, true);
  assert.equal(login.workspace, "w-a");
  const fixed = parseLogin(unmix(auth, login)).login;
  assert.equal(fixed.mixed, false);
  assert.equal(fixed.workspace, "w-a");
});

test("API keys are compared by hash and never kept in the description", () => {
  const login = describeLogin(apiKeyAuth("sk-secret-1"));
  assert.equal(login.method, "apikey");
  assert.ok(!JSON.stringify(login).includes("sk-secret-1"));
  assert.equal(sameAccount(login, describeLogin(apiKeyAuth("sk-secret-1"))), true);
  assert.equal(sameAccount(login, describeLogin(apiKeyAuth("sk-secret-2"))), false);
});

test("tokens from two different workspaces in one file are refused", () => {
  const auth = chatgptAuth({ email: "a@x.com", workspace: "w-a" });
  (auth.tokens as Record<string, string>).access_token = (chatgptAuth({ email: "b@x.com", workspace: "w-b" }).tokens as Record<string, string>).access_token!;
  assert.throws(() => describeLogin(auth), /two different accounts/);
});

test("other credential kinds are recognised", () => {
  const login = describeLogin({ auth_mode: "personalAccessToken", OPENAI_API_KEY: null, personal_access_token: "pat-1" });
  assert.equal(login.method, "other");
});

test("parse errors never echo the file content", () => {
  for (const content of ['{"tokens": "sk-very-secret', '{"OPENAI_API_KEY": null}', '[1,2]']) {
    assert.throws(() => parseLogin(Buffer.from(content)), (error: Error) => {
      assert.ok(error instanceof CdxError);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
});

test("alias suggestions are unique, safe, and never only digits", () => {
  const login = describeLogin(chatgptAuth({ email: "John.Doe+codex@x.com" }));
  assert.equal(suggestAlias(login, []), "john.doe-codex");
  assert.equal(suggestAlias(login, ["john.doe-codex"]), "john.doe-codex-2");
  assert.equal(suggestAlias(describeLogin(chatgptAuth({ email: "12345@x.com" })), []), "account-12345");
  assert.equal(suggestAlias(describeLogin(apiKeyAuth("k")), ["api-key"]), "api-key-2");
  // Reserved words and leading symbols would be rejected as aliases and block every command.
  assert.equal(suggestAlias(describeLogin(chatgptAuth({ email: "live@x.com" })), []), "account-live");
  assert.equal(suggestAlias(describeLogin(chatgptAuth({ email: "_ops@x.com" })), []), "ops");
  assert.ok(suggestAlias(describeLogin(chatgptAuth({ email: `${"a".repeat(60)}@x.com` })), Array.from({ length: 20 }, (_, i) => i ? `${"a".repeat(28)}-${i + 1}` : "a".repeat(28))).length <= 40);
});

test("bytes round-trip through parseLogin", () => {
  const { auth, login } = parseLogin(bytes(chatgptAuth({ email: "a@x.com" })));
  assert.equal(login.email, "a@x.com");
  assert.ok(typeof auth.tokens === "object");
});

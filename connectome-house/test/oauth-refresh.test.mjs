import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAnthropicOAuth } from "../src/oauth-refresh.mjs";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function freshCreds(overrides = {}) {
  return {
    anthropic: {
      type: "oauth",
      access: "access-old",
      refresh: "refresh-old",
      expires: Date.now() + 60_000,
      ...overrides,
    },
  };
}

test("fresh token: no fetch call, same object returned unchanged", async () => {
  let fetchCalled = false;
  const creds = freshCreds();
  const r = await resolveAnthropicOAuth(creds, { fetch: () => (fetchCalled = true) });
  assert.equal(fetchCalled, false);
  assert.equal(r.apiKey, "access-old");
  assert.equal(r.newCredentials, creds.anthropic); // identity, not just equality
});

test("expired: one POST with exact URL/method/headers/body, -5min expires rule", async () => {
  const calls = [];
  const now = () => 1_000_000_000_000;
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }),
    };
  };
  const creds = freshCreds({ expires: now() - 1 });
  const r = await resolveAnthropicOAuth(creds, { fetch, now });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
  assert.equal(calls[0].opts.headers["Accept"], "application/json");
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: "refresh-old",
  });

  assert.equal(r.apiKey, "access-new");
  assert.equal(r.newCredentials.access, "access-new");
  assert.equal(r.newCredentials.refresh, "refresh-new");
  assert.equal(r.newCredentials.expires, now() + 3600 * 1000 - 5 * 60_000);
  assert.notEqual(r.newCredentials, creds.anthropic); // rotated pair is a new object
});

test("refresh HTTP failure throws the retry-compatible message", async () => {
  const fetch = async () => ({ ok: false, status: 401, text: async () => "denied" });
  const creds = freshCreds({ expires: Date.now() - 1 });
  await assert.rejects(
    () => resolveAnthropicOAuth(creds, { fetch }),
    /Failed to refresh OAuth token/,
  );
});

test("refresh with invalid JSON body throws the retry-compatible message", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => "not json" });
  const creds = freshCreds({ expires: Date.now() - 1 });
  await assert.rejects(
    () => resolveAnthropicOAuth(creds, { fetch }),
    /Failed to refresh OAuth token/,
  );
});

test("no anthropic credential returns null", async () => {
  const r = await resolveAnthropicOAuth({}, { fetch: async () => assert.fail("must not fetch") });
  assert.equal(r, null);
});

/* ---- auth.mjs end-to-end, fake pi store in mkdtemp ---- */

function withPiAuthDir(dir, fn) {
  const prev = process.env.PI_AUTH_DIR;
  process.env.PI_AUTH_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PI_AUTH_DIR;
    else process.env.PI_AUTH_DIR = prev;
  });
}

test("auth.mjs: rotation persisted atomically (tmp+rename) via a fake store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oauth-refresh-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ anthropic: { type: "oauth", access: "a0", refresh: "r0", expires: 0 } }),
  );

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }),
  });

  try {
    await withPiAuthDir(dir, async () => {
      const { resolveAuth } = await import(`../src/auth.mjs?t=${Date.now()}`);
      const auth = await resolveAuth("pi");
      assert.equal(auth.kind, "oauth");
      assert.equal(auth.token, "a1");
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(existsSync(`${authPath}.tmp`), false); // rename left no .tmp behind
  const onDisk = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(onDisk.anthropic.access, "a1");
  assert.equal(onDisk.anthropic.refresh, "r1");
});

test("auth.mjs: rotation-race retry — store changes between load and attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oauth-refresh-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ anthropic: { type: "oauth", access: "a0", refresh: "r0", expires: 0 } }),
  );

  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      // simulate a concurrent process winning the refresh and rewriting the
      // store while our first attempt is in flight, then failing this attempt
      writeFileSync(
        authPath,
        JSON.stringify({ anthropic: { type: "oauth", access: "a-race", refresh: "r-race", expires: Date.now() + 60_000 } }),
      );
      return { ok: false, status: 401, text: async () => "raced out" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }) };
  };

  try {
    await withPiAuthDir(dir, async () => {
      const { resolveAuth } = await import(`../src/auth.mjs?t=${Date.now()}-race`);
      const auth = await resolveAuth("pi");
      // the reloaded store's token was already fresh (expires in the future),
      // so the retried attempt returns it without a second fetch.
      assert.equal(auth.token, "a-race");
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(calls, 1); // only the first, losing attempt actually hit the network
  const onDisk = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(onDisk.anthropic.access, "a-race");
});

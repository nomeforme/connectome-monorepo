// @ts-check
/* harness/test/stream-key.test.mjs — canonicalStream (stream-key.mjs):
 * Discord/Signal-group passthrough, a Signal DM's peer digest, the
 * account segment (only for a non-primary account), and back-compat
 * (a bare pre-existing key form still comes out bare by default). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountDigest, canonicalStream } from "../src/stream-key.mjs";

const PEER_UUID = "0f0f0f0f-1111-4222-8333-444444444444";
const ACCOUNT_A = "+15550009999";
const ACCOUNT_B = "+15550008888";

test("non-signal or non-DM streams pass through unchanged", () => {
  assert.equal(canonicalStream("discord", "discord:111:222"), "discord:111:222");
  assert.equal(canonicalStream("signal", "signal:group:abc"), "signal:group:abc");
  assert.equal(canonicalStream("web", "web:foo:123-a1"), "web:foo:123-a1");
});

test("a Signal DM's peer is always a digest, never the raw uuid or phone", () => {
  const key = canonicalStream("signal", `signal:dm:${PEER_UUID}`);
  assert.match(key, /^signal:dm:[0-9a-f]{12}$/);
  assert.ok(!key.includes(PEER_UUID));
});

test("back-compat: no account info at all (today's live raw form) keys bare — matches every room already on disk", () => {
  const bare = canonicalStream("signal", `signal:dm:${PEER_UUID}`);
  assert.match(bare, /^signal:dm:[0-9a-f]{12}$/, "exactly one segment after signal:dm:");
});

test("primary account (default true) keys bare even when an account IS known", () => {
  const withAccount = canonicalStream("signal", `signal:dm:${PEER_UUID}`, { account: ACCOUNT_A });
  const noAccount = canonicalStream("signal", `signal:dm:${PEER_UUID}`);
  assert.equal(
    withAccount,
    noAccount,
    "primary defaults true — same key whether or not the account is named",
  );
});

test("a non-primary account adds a digested account segment — two accounts, two rooms for the same peer", () => {
  const a = canonicalStream("signal", `signal:dm:${PEER_UUID}`, {
    account: ACCOUNT_A,
    primary: false,
  });
  const b = canonicalStream("signal", `signal:dm:${PEER_UUID}`, {
    account: ACCOUNT_B,
    primary: false,
  });
  assert.notEqual(a, b, "distinct accounts must not collapse into one room");
  assert.match(a, /^signal:dm:[0-9a-f]{12}:[0-9a-f]{12}$/);
  assert.ok(!a.includes(ACCOUNT_A.replace("+", "")));
  assert.equal(accountDigest(ACCOUNT_A), accountDigest(ACCOUNT_A), "deterministic");
  assert.notEqual(accountDigest(ACCOUNT_A), accountDigest(ACCOUNT_B));
});

test("an embedded account (a raw two-segment form) is read from `raw` when `account` isn't passed", () => {
  const raw = `signal:dm:${ACCOUNT_A}:${PEER_UUID}`;
  const bare = canonicalStream("signal", raw, { primary: true });
  const keyed = canonicalStream("signal", raw, { primary: false });
  assert.match(bare, /^signal:dm:[0-9a-f]{12}$/);
  assert.match(keyed, /^signal:dm:[0-9a-f]{12}:[0-9a-f]{12}$/);
  assert.equal(keyed.split(":")[2], accountDigest(ACCOUNT_A));
});

test("a Signal DM keyed two different ways (embedded vs separately-known account) resolves to the same key for the same (primary) account and peer", () => {
  // a raw form that already embeds the account, and a live seat's raw
  // channel id carrying the peer alone (mcpl/signal.mjs's roomKey) — both
  // must land on the same key once the account is known to be primary.
  const embeddedRaw = `signal:dm:${ACCOUNT_A}:${PEER_UUID}`;
  const liveRaw = `signal:dm:${PEER_UUID}`;
  const embeddedKey = canonicalStream("signal", embeddedRaw, { primary: true });
  const liveKey = canonicalStream("signal", liveRaw, { account: ACCOUNT_A, primary: true });
  assert.equal(embeddedKey, liveKey);
});

test("primary as a predicate (a 'first account wins' policy)", () => {
  const isPrimary = (acct) => acct === ACCOUNT_A;
  const a = canonicalStream("signal", `signal:dm:${ACCOUNT_A}:${PEER_UUID}`, {
    primary: isPrimary,
  });
  const b = canonicalStream("signal", `signal:dm:${ACCOUNT_B}:${PEER_UUID}`, {
    primary: isPrimary,
  });
  assert.match(a, /^signal:dm:[0-9a-f]{12}$/, "the primary account stays bare");
  assert.match(b, /^signal:dm:[0-9a-f]{12}:[0-9a-f]{12}$/, "a second account is keyed");
});

test("an unexpected number of segments is left raw, never guessed at", () => {
  const odd = "signal:dm:a:b:c";
  assert.equal(canonicalStream("signal", odd), odd);
});

// @ts-check
/* connectome-house/test/mcpl-signal-identity-w5a.test.mjs — harness-port
 * W5-A, 2026-09-19: the two new servers-file fields (`rooms_policy`,
 * `number_env`) validated by the REAL config.mjs, and the seat's own
 * Signal-style identity — `cfg.number_id = phoneId(process.env[NAME])`,
 * christened the way `being_id` is (room-tails.mjs's `christenBeing`,
 * extended this task to fall back to `number_id`) — exercised with a
 * `+1555…` fake number, never a real one. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR before the FIRST
// import of anything under src/ — config.mjs -> testaments.mjs ->
// serve-paths.mjs reads these once, at module load (every other test
// file in this package names this same trap).
const ROOT = mkdtempSync(join(tmpdir(), "w5a-identity-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "w5a-identity-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { validateServer, loadServersConfig } = await import("../src/mcpl/config.mjs");
const { phoneId, identityFor, rechristen } = await import("../src/identity-map.mjs");
const { christenBeing } = await import("../src/mcpl/room-tails.mjs");

/** the real `rechristen`, wrapped so a test can also assert it was called
 * (a bare no-op stand-in would leave the identity map un-rewritten, and
 * every "was it christened" assertion below would then be checking
 * nothing real). @param {{from: string, to: string}[]} calls */
const spyRechristen = (calls) => (from, to) => {
  calls.push({ from, to });
  return rechristen(from, to);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FAKE_NUMBER = "+15550001234"; // signal-cli's own fixture convention (mcpl-signal/test/lib/mock-signal-cli.mjs's NUMBERS) — never a real one

/* ---------------------------------------------------------------------- */
/* config.mjs: rooms_policy / number_env, validateServer's own shape gate */
/* ---------------------------------------------------------------------- */

const BASE = { name: "s1", platform: "signal", command: "node", being: "watson" };

test("validateServer: rooms_policy unset defaults to \"listed\"", () => {
  const v = validateServer({ ...BASE });
  assert.equal(v.rooms_policy, "listed");
});

test('validateServer: rooms_policy "any" is accepted verbatim', () => {
  const v = validateServer({ ...BASE, rooms_policy: "any" });
  assert.equal(v.rooms_policy, "any");
});

test("validateServer: an invalid rooms_policy value is refused, naming the server", () => {
  const v = validateServer({ ...BASE, rooms_policy: "everywhere" });
  assert.equal(typeof v, "string");
  assert.match(v, /rooms_policy/);
});

test("validateServer: number_env unset -> null; a valid NAME is accepted", () => {
  const unset = validateServer({ ...BASE });
  assert.equal(unset.number_env, null);
  const v = validateServer({ ...BASE, number_env: "SIGNAL_PHONE_CLAUDE_HAIKU_4_5" });
  assert.equal(v.number_env, "SIGNAL_PHONE_CLAUDE_HAIKU_4_5");
});

test("validateServer: a lowercase/malformed number_env is refused, by name only (never a value)", () => {
  const v = validateServer({ ...BASE, number_env: "signal_phone" });
  assert.equal(typeof v, "string");
  assert.match(v, /number_env/);
});

test("loadServersConfig: the real house/servers.json's signal-haiku-4-5 entry, fake env, 555 number — rooms_policy \"any\", number_env named, env lists both variables", () => {
  const path = join(REPO_ROOT, "house", "servers.json");
  const { servers, errors } = loadServersConfig({
    HOUSE_MCPL_SERVERS: path,
    SIGNAL_CLI_URL: "http://signal-cli:8080",
    SIGNAL_PHONE_CLAUDE_HAIKU_4_5: FAKE_NUMBER,
  });
  assert.deepEqual(errors, []);
  const server = servers.find((s) => s.name === "signal-haiku-4-5");
  assert.ok(server, "the real servers.json's own new entry");
  assert.equal(server.platform, "signal");
  assert.equal(server.being, "claude-haiku-4-5");
  assert.equal(server.rooms_policy, "any");
  assert.equal(server.number_env, "SIGNAL_PHONE_CLAUDE_HAIKU_4_5");
  assert.deepEqual(server.env, ["SIGNAL_CLI_URL", "SIGNAL_PHONE_CLAUDE_HAIKU_4_5"]);
  assert.equal(server.observe_only, false);
  assert.equal(server.box, "sfo");
  assert.ok(!JSON.stringify(server).includes(FAKE_NUMBER), "the fake number itself never rides in the parsed config — only its variable NAME does");
});

/* ---------------------------------------------------------------------- */
/* christenBeing: number_id fallback (this task's own extension), a 555   */
/* fake number hashed by the real phoneId — never the number itself       */
/* ---------------------------------------------------------------------- */

test("christenBeing: with no being_id, falls back to number_id — a fresh pseudonym is rechristened to the being's own handle", () => {
  const numberId = phoneId(FAKE_NUMBER); // what seat.mjs's deriveNumberId computes
  assert.equal(numberId.length, 64, "sha256 hex — never the number itself");
  assert.ok(!numberId.includes("1234"), "no digit substring of the fake number survives the hash");

  const cfg = { platform: "signal", being: "zz-w5a-being", being_id: null, number_id: numberId };
  const rechristened = [];
  christenBeing(cfg, identityFor, spyRechristen(rechristened), () => {});

  const who = identityFor({ platform: "signal", id: numberId, display: null });
  assert.equal(who.handle, "zz-w5a-being", "the christened handle, not a fresh pseudonym");
  assert.equal(rechristened.length, 1);
  assert.equal(rechristened[0].to, "zz-w5a-being");
});

test("christenBeing: neither being_id nor number_id set — a documented no-op, never a throw", () => {
  const cfg = { platform: "signal", being: "zz-w5a-being-2" };
  assert.doesNotThrow(() => christenBeing(cfg, identityFor, () => assert.fail("never called"), () => {}));
});

test("christenBeing: being_id still wins over number_id when both are set (Discord's own path, unchanged)", () => {
  const cfg = { platform: "discord", being: "zz-w5a-being-3", being_id: "discord-id-1", number_id: "should-not-be-used" };
  christenBeing(cfg, identityFor, spyRechristen([]), () => {});
  const who = identityFor({ platform: "discord", id: "discord-id-1", display: null });
  assert.equal(who.handle, "zz-w5a-being-3");
});

// this file's own mkdtemp sandbox (ROOT) is left in place — deferred-ops:
// never rm'd from a test, the OS reaps /tmp.

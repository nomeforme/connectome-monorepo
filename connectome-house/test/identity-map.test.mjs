// @ts-check
/* harness/test/identity-map.test.mjs — platform identity -> house handle
 * (src/identity-map.mjs): the pseudonym derivation (stable, salted, refuses
 * unsalted or short salts), known-entry precedence, rechristen's
 * scan-not-rewrite contract, the phone-number discipline (never stored,
 * not even in `display`), and the `linked` flag platform-reach added
 * (identityFor/linkIdentity/unlinkIdentity/linkedPlatformsFor).
 *
 * HOUSE_PRIVATE_DIR, HOUSE_RUNS_DIR, HOUSE_COVENANTS_DIR are sandboxed BEFORE
 * the first import (serve-paths.mjs reads them once, at module-eval time)
 * — never the repo's real harness/private, harness/runs, or address/. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

let sandboxPrivate, sandboxRuns, sandboxAddress;
let identityFor, identityKnown, identityMapPath, identityMapReverse, linkIdentity, linkedPlatformsFor, unlinkIdentity, phoneId, rechristen, MIN_SALT_LENGTH;
let HANDLE_RE;

before(async () => {
  sandboxPrivate = mkdtempSync(join(tmpdir(), "identity-map-private-"));
  sandboxRuns = mkdtempSync(join(tmpdir(), "identity-map-runs-"));
  sandboxAddress = mkdtempSync(join(tmpdir(), "identity-map-address-"));
  process.env.HOUSE_PRIVATE_DIR = sandboxPrivate;
  process.env.HOUSE_RUNS_DIR = sandboxRuns;
  process.env.HOUSE_COVENANTS_DIR = sandboxAddress;
  ({
    identityFor,
    identityKnown,
    identityMapPath,
    identityMapReverse,
    linkIdentity,
    linkedPlatformsFor,
    unlinkIdentity,
    phoneId,
    rechristen,
    MIN_SALT_LENGTH,
  } = await import("../src/identity-map.mjs"));
  ({ HANDLE_RE } = await import("../src/testaments.mjs"));
});

after(() => {
  rmSync(sandboxPrivate, { recursive: true, force: true });
  rmSync(sandboxRuns, { recursive: true, force: true });
  rmSync(sandboxAddress, { recursive: true, force: true });
  delete process.env.HOUSE_PRIVATE_DIR;
  delete process.env.HOUSE_RUNS_DIR;
  delete process.env.HOUSE_COVENANTS_DIR;
  delete process.env.HOUSE_IDENTITY_SALT;
});

beforeEach(() => {
  // a clean identity map before every test — tests don't leak into each
  // other via the shared sandboxed store.
  writeFileSync(identityMapPath(), JSON.stringify({ version: 1, entries: {} }));
  process.env.HOUSE_IDENTITY_SALT = "test-salt-one-long-enough";
});

test("identityFor: missing salt refuses (never an unsalted derivation)", () => {
  delete process.env.HOUSE_IDENTITY_SALT;
  assert.throws(
    () => identityFor({ platform: "discord", id: "user-1" }),
    /HOUSE_IDENTITY_SALT/,
  );
});

test("identityFor: a salt shorter than MIN_SALT_LENGTH refuses, naming the length; exactly MIN passes", () => {
  process.env.HOUSE_IDENTITY_SALT = "x".repeat(MIN_SALT_LENGTH - 1);
  assert.throws(
    () => identityFor({ platform: "discord", id: "user-short-salt" }),
    new RegExp(`${MIN_SALT_LENGTH - 1} chars.*at least ${MIN_SALT_LENGTH}`),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(identityMapPath(), "utf8")).entries,
    {},
    "nothing was written back for the refused derivation",
  );
  process.env.HOUSE_IDENTITY_SALT = "y".repeat(MIN_SALT_LENGTH);
  assert.match(identityFor({ platform: "discord", id: "user-short-salt" }).handle, /^discord-/);
});

test("identityFor: an unknown sender gets a stable pseudonym, handle-shaped, known:false", () => {
  const out = identityFor({ platform: "discord", id: "user-42", display: "Alice" });
  assert.equal(out.known, false);
  assert.equal(out.home, "discord");
  assert.match(out.handle, /^discord-[a-z2-7]{6}$/);
  assert.ok(HANDLE_RE.test(out.handle), "the derived pseudonym is a valid house handle shape");
});

test("identityFor: the same platform+id returns the same handle every time, and known:true thereafter", () => {
  const first = identityFor({ platform: "signal", id: "uuid-abc" });
  const second = identityFor({ platform: "signal", id: "uuid-abc" });
  assert.equal(second.handle, first.handle);
  assert.equal(second.known, true, "a repeat lookup finds the entry this module wrote back");
});

test("identityFor: a different salt derives a different pseudonym for the same id (no prior entry)", () => {
  const a = identityFor({ platform: "discord", id: "same-id-different-salt" });
  // wipe the store so the second call is genuinely unmapped, not a lookup
  writeFileSync(identityMapPath(), JSON.stringify({ version: 1, entries: {} }));
  process.env.HOUSE_IDENTITY_SALT = "a-completely-different-salt";
  const b = identityFor({ platform: "discord", id: "same-id-different-salt" });
  assert.notEqual(b.handle, a.handle, "the salt is load-bearing in the derivation, not decorative");
});

test("identityFor: a known entry wins over a fresh derivation — passing a new `display` doesn't move the handle", () => {
  const first = identityFor({ platform: "web", id: "session-1", display: "Original Name" });
  const second = identityFor({ platform: "web", id: "session-1", display: "A Totally Different Name" });
  assert.equal(second.handle, first.handle);
  assert.equal(second.known, true);
});

test("identityFor: a phone-shaped display is never stored, even for an unmapped sender", () => {
  identityFor({ platform: "signal", id: phoneId("+15551234567"), display: "+1 555 123 4567" });
  const raw = JSON.parse(readFileSync(identityMapPath(), "utf8"));
  const entry = Object.values(raw.entries)[0];
  assert.equal(entry.display, null, "a phone-shaped display is dropped, not stored");
  assert.ok(!JSON.stringify(raw).includes("5551234567"), "the raw phone digits never reach the store at all");
});

test("phoneId: sha256(phone) hex, never the phone itself", () => {
  const id = phoneId("+15551234567");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.ok(!id.includes("555"), "the digest carries no recognizable trace of the digits");
});

test("identityKnown: true for a handle this module has mapped", () => {
  const { handle } = identityFor({ platform: "discord", id: "user-99" });
  assert.equal(identityKnown(handle), true);
});

test("identityKnown: true for a testament handle even with no identity-map entry (reuses testaments.mjs's knownHandle)", () => {
  writeTestament(sandboxAddress, "zz-idmap-testament");
  assert.equal(identityKnown("zz-idmap-testament"), true);
});

test("identityKnown: false for a handle neither mapped nor testamented", () => {
  assert.equal(identityKnown("nobody-home-at-all"), false);
});

test("rechristen: repoints the entry, and identityFor now returns the new handle", () => {
  const { handle: oldHandle } = identityFor({ platform: "discord", id: "user-to-rename" });
  const result = rechristen(oldHandle, "the-actual-person");
  assert.equal(result.renamed, true);
  const after = identityFor({ platform: "discord", id: "user-to-rename" });
  assert.equal(after.handle, "the-actual-person");
  assert.equal(after.known, true);
});

test("rechristen: returns every run id naming the old handle, WITHOUT rewriting their records", () => {
  const { handle: oldHandle } = identityFor({ platform: "discord", id: "user-with-runs" });
  // a run whose class.json.participants names the old (pseudonym) handle
  const runDir = join(sandboxRuns, "run-naming-old-handle");
  mkdirSync(runDir, { recursive: true });
  const classJson = JSON.stringify({ participants: [{ handle: oldHandle, kind: "human" }] });
  writeFileSync(join(runDir, "class.json"), classJson);
  // a run that does NOT name it, to prove the scan isn't just "every run"
  const otherRunDir = join(sandboxRuns, "run-unrelated");
  mkdirSync(otherRunDir, { recursive: true });
  writeFileSync(join(otherRunDir, "class.json"), JSON.stringify({ participants: [{ handle: "someone-else" }] }));

  const result = rechristen(oldHandle, "christened-name");
  assert.deepEqual(result.affectedRuns, ["run-naming-old-handle"]);
  assert.match(result.note, /NOT rewritten/);
  // the record itself is untouched — still names the OLD handle verbatim.
  assert.equal(readFileSync(join(runDir, "class.json"), "utf8"), classJson);
});

test("rechristen: refuses an invalid new-handle shape", () => {
  const { handle: oldHandle } = identityFor({ platform: "discord", id: "user-bad-rename" });
  assert.throws(() => rechristen(oldHandle, "Not A Valid Handle!"), /not a valid handle/);
});

test("linkIdentity: refuses a handle the house does not know — never mints one by fiat", () => {
  assert.throws(
    () => linkIdentity({ platform: "discord", id: "user-link-1", handle: "nobody-home-at-all" }),
    /not a handle the house knows/,
  );
});

test("linkIdentity: repoints an auto-minted pseudonym to a handle the house knows (a testament), keeping first_seen", () => {
  writeTestament(sandboxAddress, "zz-link-robin");
  const { handle: pseudonym } = identityFor({ platform: "discord", id: "user-to-link" });
  const before = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries[`discord:user-to-link`];
  const result = linkIdentity({ platform: "discord", id: "user-to-link", handle: "zz-link-robin" });
  assert.deepEqual(result, { linked: true, previous: pseudonym });
  const after = identityFor({ platform: "discord", id: "user-to-link" });
  assert.equal(after.handle, "zz-link-robin");
  assert.equal(after.known, true);
  const entry = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries["discord:user-to-link"];
  assert.equal(entry.first_seen, before.first_seen, "linking an existing entry keeps its first_seen");
});

test("linkIdentity: creates a fresh entry (previous: null) when no identity-map row exists yet for that platform+id", () => {
  writeTestament(sandboxAddress, "zz-link-fresh");
  const result = linkIdentity({ platform: "discord", id: "user-never-seen", handle: "zz-link-fresh" });
  assert.deepEqual(result, { linked: true, previous: null });
  assert.equal(identityFor({ platform: "discord", id: "user-never-seen" }).handle, "zz-link-fresh");
});

test("linkIdentity: a phone-shaped display is never stored, same guard as identityFor", () => {
  writeTestament(sandboxAddress, "zz-link-phone");
  linkIdentity({
    platform: "signal",
    id: "user-link-phone",
    handle: "zz-link-phone",
    display: "+1 555 000 1234",
  });
  const entry = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries["signal:user-link-phone"];
  assert.equal(entry.display, null);
});

test("linkIdentity: platform and id are both required; an invalid handle shape refuses too", () => {
  assert.throws(() => linkIdentity({ platform: "", id: "x", handle: "zz-link-robin" }));
  assert.throws(() => linkIdentity({ platform: "discord", id: "", handle: "zz-link-robin" }));
  assert.throws(
    () => linkIdentity({ platform: "discord", id: "x", handle: "Not A Handle!" }),
    /not a valid handle shape/,
  );
});

test("identityFor: known:true from linkIdentity carries linked:true; an auto-minted pseudonym is known:false, linked:false", () => {
  writeTestament(sandboxAddress, "zz-link-flag");
  const fresh = identityFor({ platform: "discord", id: "user-linked-flag" });
  assert.equal(fresh.linked, false);
  linkIdentity({ platform: "discord", id: "user-linked-flag", handle: "zz-link-flag" });
  const after = identityFor({ platform: "discord", id: "user-linked-flag" });
  assert.equal(after.known, true);
  assert.equal(after.linked, true);
});

test("identityFor: a real entry written before the `linked` field existed reads linked:false, not a throw", () => {
  writeFileSync(
    identityMapPath(),
    JSON.stringify({
      version: 1,
      entries: { "discord:legacy-user": { handle: "zz-legacy", display: null, first_seen: "2026-01-01T00:00:00.000Z", home: "discord" } },
    }),
  );
  const out = identityFor({ platform: "discord", id: "legacy-user" });
  assert.equal(out.known, true);
  assert.equal(out.linked, false);
});

test("unlinkIdentity: flips linked:false in place — handle, first_seen, home untouched; a re-link flips the SAME entry back", () => {
  writeTestament(sandboxAddress, "zz-unlink-target");
  linkIdentity({ platform: "signal", id: "user-unlink-1", handle: "zz-unlink-target" });
  const before = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries["signal:user-unlink-1"];
  const result = unlinkIdentity("signal", "zz-unlink-target");
  assert.deepEqual(result, { unlinked: true, count: 1 });
  const mid = identityFor({ platform: "signal", id: "user-unlink-1" });
  assert.equal(mid.known, true, "the entry itself is never deleted");
  assert.equal(mid.linked, false);
  const midRaw = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries["signal:user-unlink-1"];
  assert.equal(midRaw.handle, before.handle);
  assert.equal(midRaw.first_seen, before.first_seen);
  assert.equal(midRaw.home, before.home);
  // a second unlink on an already-unlinked entry is a no-op, not an error
  assert.deepEqual(unlinkIdentity("signal", "zz-unlink-target"), { unlinked: false, count: 0 });
  linkIdentity({ platform: "signal", id: "user-unlink-1", handle: "zz-unlink-target" });
  assert.equal(identityFor({ platform: "signal", id: "user-unlink-1" }).linked, true);
});

test("unlinkIdentity: only the named platform's entries for that handle are touched", () => {
  writeTestament(sandboxAddress, "zz-multi-platform");
  linkIdentity({ platform: "discord", id: "user-multi-1", handle: "zz-multi-platform" });
  linkIdentity({ platform: "signal", id: "user-multi-2", handle: "zz-multi-platform" });
  unlinkIdentity("discord", "zz-multi-platform");
  assert.equal(identityFor({ platform: "discord", id: "user-multi-1" }).linked, false);
  assert.equal(identityFor({ platform: "signal", id: "user-multi-2" }).linked, true, "signal's own link is untouched");
});

test("linkedPlatformsFor: every platform this handle currently holds a live link on, never the platform id", () => {
  writeTestament(sandboxAddress, "zz-connected");
  assert.deepEqual(linkedPlatformsFor("zz-connected"), []);
  linkIdentity({ platform: "discord", id: "user-conn-1", handle: "zz-connected", display: "kai" });
  linkIdentity({ platform: "signal", id: "user-conn-2", handle: "zz-connected" });
  const rows = linkedPlatformsFor("zz-connected");
  assert.deepEqual(
    rows.map((r) => r.platform).sort(),
    ["discord", "signal"],
  );
  assert.ok(!JSON.stringify(rows).includes("user-conn-1"), "never the platform id");
  unlinkIdentity("discord", "zz-connected");
  assert.deepEqual(
    linkedPlatformsFor("zz-connected").map((r) => r.platform),
    ["signal"],
  );
});

test("identityFor: platform and id are both required", () => {
  assert.throws(() => identityFor({ platform: "", id: "x" }));
  assert.throws(() => identityFor({ platform: "discord", id: "" }));
});

test("identityMapReverse: the one road back from a handle to its platform id — by platform, else the first stored; null when unmapped", () => {
  const { handle } = identityFor({ platform: "discord", id: "user-reverse-1", display: "Rev" });
  assert.deepEqual(identityMapReverse(handle), { platform: "discord", id: "user-reverse-1" });
  assert.deepEqual(identityMapReverse(handle, "discord"), { platform: "discord", id: "user-reverse-1" });
  assert.equal(identityMapReverse(handle, "signal"), null, "no entry on that platform");
  assert.equal(identityMapReverse("never-mapped-handle"), null);
  // a christened handle that spans two platforms answers per platform
  const sig = identityFor({ platform: "signal", id: "uuid-reverse-1" });
  rechristen(sig.handle, handle);
  assert.deepEqual(identityMapReverse(handle, "signal"), { platform: "signal", id: "uuid-reverse-1" });
  assert.deepEqual(identityMapReverse(handle, "discord"), { platform: "discord", id: "user-reverse-1" });
});

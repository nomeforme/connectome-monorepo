// @ts-check
/* mcpl-signal/test/privacy.test.mjs — the two modes, the privacy file
 * (live re-read, fail-closed on a broken file), the hard allowlist, the
 * dot prefix, dedup, and the split. */
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isUuid } from "../src/envelopes.mjs";
import { idMentionsOnSend, mentionsOnSend, splitMessage } from "../src/outbound.mjs";
import { createDedup, createPrivacy } from "../src/privacy.mjs";

const g = (over = {}) => ({
  isDM: false,
  groupId: "g1",
  dotPrefixed: false,
  mentionsSelf: false,
  quotesSelf: false,
  ...over,
});
const dir = mkdtempSync(join(tmpdir(), "mcpl-signal-privacy-"));
let n = 0;
const fileWith = (obj) => {
  const p = join(dir, `p${++n}.json`);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
};

test("opt-out (default): everything passes unless the group or the message opted out; DMs always", () => {
  const p = createPrivacy({
    mode: "opt-out",
    file: fileWith({ optOut: ["g2"] }),
    allowedGroups: null,
  });
  assert.equal(p.admit(g()).admit, true);
  assert.equal(p.admit(g({ groupId: "g2" })).reason, "group-opted-out");
  assert.equal(
    p.admit(g({ groupId: "g2", mentionsSelf: true })).admit,
    false,
    "a group's no is a no",
  );
  assert.equal(p.admit(g({ dotPrefixed: true })).reason, "dot-opt-out");
  assert.equal(p.admit(g({ dotPrefixed: true, mentionsSelf: true })).admit, false);
  assert.equal(p.admit(g({ isDM: true, groupId: null, dotPrefixed: true })).admit, true);
  assert.equal(p.snapshot().mode, "opt-out");
});

test("opt-in: only listed groups are ambient; elsewhere a mention, a quote, or a dot lets one message through", () => {
  const p = createPrivacy({
    mode: "opt-in",
    file: fileWith({ optIn: ["g1"] }),
    allowedGroups: null,
  });
  assert.equal(p.admit(g()).reason, "group-opted-in");
  assert.equal(p.admit(g({ groupId: "g2" })).reason, "not-opted-in");
  assert.equal(p.admit(g({ groupId: "g2", mentionsSelf: true })).reason, "addressed");
  assert.equal(p.admit(g({ groupId: "g2", quotesSelf: true })).admit, true);
  assert.equal(
    p.admit(g({ groupId: "g2", fromSelf: true })).admit,
    true,
    "the account's own words",
  );
  const dot = p.admit(g({ groupId: "g2", dotPrefixed: true }));
  assert.deepEqual(
    dot,
    { admit: true, reason: "dot-opt-in", textOffset: 1 },
    "the dot is stripped",
  );
  assert.equal(p.admit(g({ isDM: true, groupId: null })).admit, true);
});

test("no file: opt-out forwards, opt-in forwards only addressed", () => {
  const out = createPrivacy({ mode: "opt-out", file: null, allowedGroups: null });
  assert.equal(out.admit(g()).admit, true);
  const inn = createPrivacy({ mode: "opt-in", file: null, allowedGroups: null });
  assert.equal(inn.admit(g()).admit, false);
  assert.equal(inn.admit(g({ mentionsSelf: true })).admit, true);
});

test("a CONFIGURED but MISSING privacy file fails closed — unlike file: null (no policy at all), a named path that does not exist forwards nothing ambient, and the log names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpl-signal-privacy-missing-"));
  const missingPath = join(dir, "not-there.json");
  const logs = [];
  const p = createPrivacy({
    mode: "opt-out",
    file: missingPath,
    allowedGroups: null,
    log: (l) => logs.push(l),
  });
  assert.equal(p.admit(g()).reason, "privacy-file-broken", "opt-out still forwards nothing ambient");
  assert.equal(p.admit(g({ mentionsSelf: true })).admit, true, "addressed traffic still passes");
  assert.ok(
    logs.some((l) => l.includes(missingPath) && /missing/.test(l)),
    "the log names the file by its path",
  );
  const inn = createPrivacy({ mode: "opt-in", file: missingPath, allowedGroups: null });
  assert.equal(inn.admit(g()).reason, "privacy-file-broken");
  // once the file appears, it reads normally — no restart needed
  writeFileSync(missingPath, JSON.stringify({ optOut: ["g1"] }));
  const later = new Date(Date.now() + 5000);
  utimesSync(missingPath, later, later);
  assert.equal(p.admit(g()).reason, "group-opted-out");
});

test("the file is re-read when it changes; a broken file fails closed, the last good reading stands", () => {
  const logs = [];
  const path = fileWith({ optOut: [] });
  const p = createPrivacy({
    mode: "opt-out",
    file: path,
    allowedGroups: null,
    log: (l) => logs.push(l),
  });
  assert.equal(p.admit(g({ groupId: "g9" })).admit, true);
  writeFileSync(path, JSON.stringify({ optOut: ["g9"] }));
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  assert.equal(p.admit(g({ groupId: "g9" })).admit, false, "the edit landed without a restart");
  writeFileSync(path, "{ not json");
  const later2 = new Date(Date.now() + 10_000);
  utimesSync(path, later2, later2);
  assert.equal(p.admit(g({ groupId: "g9" })).admit, false, "last good reading stands");
  assert.equal(p.admit(g({ groupId: "g1" })).admit, true);
  assert.ok(logs.some((l) => /failed to parse/.test(l)));
  assert.equal(p.snapshot().broken, true);
  // broken from the start, opt-out: nothing ambient until fixed; addressed still passes
  const broken = createPrivacy({ mode: "opt-out", file: fileWith("nope"), allowedGroups: null });
  assert.equal(broken.admit(g()).reason, "privacy-file-broken");
  assert.equal(broken.admit(g({ mentionsSelf: true })).admit, true);
});

test("SIGNAL_ALLOWED_GROUPS is a hard allowlist ahead of either mode", () => {
  const p = createPrivacy({ mode: "opt-out", file: null, allowedGroups: ["g1"] });
  assert.equal(p.admit(g()).admit, true);
  assert.equal(p.admit(g({ groupId: "g2", mentionsSelf: true })).reason, "not-allowed");
  assert.equal(p.admit(g({ isDM: true, groupId: null })).admit, true, "DMs are not groups");
});

test("dedup: first sight true, the rest false, bounded", () => {
  const seen = createDedup(3);
  assert.equal(seen("a"), true);
  assert.equal(seen("a"), false);
  assert.equal(seen("b"), true);
  assert.equal(seen("c"), true);
  assert.equal(seen("d"), true);
  assert.equal(seen("a"), true, "evicted oldest");
});

test("split: 0 is native (Signal's 4096 only); a limit cuts at paragraphs, then sentences, then words", () => {
  assert.deepEqual(splitMessage("short", 0), ["short"]);
  assert.deepEqual(splitMessage("   ", 100), []);
  const paras = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
  assert.deepEqual(splitMessage(paras, 130), [
    `${"a".repeat(60)}\n\n${"b".repeat(60)}`,
    "c".repeat(60),
  ]);
  const sentences =
    "One sentence here. Another one follows. And a third that is longer than the rest.";
  const s = splitMessage(sentences, 45);
  assert.ok(s.length >= 2 && s.every((c) => c.length <= 45));
  assert.equal(s.join(" "), sentences);
  const long = "x".repeat(9000);
  const native = splitMessage(long, 0);
  assert.equal(native.length, 3);
  assert.ok(native.every((c) => c.length <= 4096));
  assert.equal(splitMessage("hello world", 5000).length, 1);
  assert.deepEqual(splitMessage("a b c d e f", 4), ["a b", "c d", "e f"]);
});

test("mentions on send: @name → U+FFFC + {start, length 1, author}; unknown names stay literal", () => {
  const names = new Map([
    ["alice", "uuid-alice"],
    ["al", "uuid-al"],
  ]);
  const r = mentionsOnSend("hey @alice, and @al: @nobody @alicex", names);
  assert.equal(r.text, "hey ￼, and ￼: @nobody @alicex");
  assert.deepEqual(r.mentions, [
    { start: 4, length: 1, author: "uuid-alice" },
    { start: 11, length: 1, author: "uuid-al" },
  ]);
  assert.deepEqual(mentionsOnSend("plain", names).mentions, []);
});

test("mentions on send: isDM never builds one — @name goes out exactly as written, no placeholder, no mentions[]", () => {
  const names = new Map([["alice", "uuid-alice"]]);
  const r = mentionsOnSend("hi @alice", names, true);
  assert.deepEqual(r, { text: "hi @alice", mentions: [] });
});

test("idMentionsOnSend: <@uuid> resolves as itself, <@digest> through the number map, an unresolved id falls back to @name or drops clean — never a raw id", () => {
  const uuid = "aaaaaaaa-0000-4000-8000-000000000001";
  const digest = "f".repeat(64);
  const unknownDigest = "0".repeat(64);
  const numbers = new Map([[digest, "+15550001111"]]);
  const names = new Map([[unknownDigest, "carol"]]); // exercised for shape only — see below
  const deps = {
    isUuid,
    numberFor: (id) => numbers.get(id) ?? null,
    nameFor: (id) => names.get(id) ?? null,
  };
  const r = idMentionsOnSend(`hey <@${uuid}> and <@${digest}> and <@${unknownDigest}>`, deps);
  assert.equal(r.text, "hey ￼ and ￼ and @carol");
  assert.deepEqual(r.mentions, [
    { start: 4, length: 1, author: uuid },
    { start: 10, length: 1, author: "+15550001111" },
  ]);
  assert.deepEqual(r.dropped, [{ id: unknownDigest, reason: "unresolved — fell back to @carol" }]);
  assert.deepEqual(idMentionsOnSend("no tokens here", deps), { text: "no tokens here", mentions: [], dropped: [] });
  // no number, no name: dropped whole, never a raw id on the wire
  const gone = idMentionsOnSend(`only <@${unknownDigest}> here`, { ...deps, nameFor: () => null });
  assert.equal(gone.text, "only  here");
  assert.deepEqual(gone.mentions, []);
  assert.deepEqual(gone.dropped, [{ id: unknownDigest, reason: "unresolved — dropped" }]);
  assert.ok(!gone.text.includes("<@"), "never a raw id");
});

test("idMentionsOnSend: isDM — even a resolvable <@uuid>/<@digest> never becomes a placeholder mention; falls back to @name or drops, same as unresolved", () => {
  const uuid = "aaaaaaaa-0000-4000-8000-000000000001";
  const digest = "f".repeat(64);
  const numbers = new Map([[digest, "+15550001111"]]);
  const names = new Map([[uuid, "bob"]]);
  const deps = {
    isUuid,
    numberFor: (id) => numbers.get(id) ?? null,
    nameFor: (id) => names.get(id) ?? null,
    isDM: true,
  };
  const r = idMentionsOnSend(`hey <@${uuid}> and <@${digest}>`, deps);
  assert.equal(r.text, "hey @bob and ", "the uuid resolves to a known name instead; the digest has none, dropped");
  assert.deepEqual(r.mentions, [], "isDM: never a placeholder mention, however resolvable the id");
  assert.deepEqual(r.dropped, [
    { id: uuid, reason: "dm — rendered as @bob" },
    { id: digest, reason: "dm — dropped" },
  ]);
  assert.ok(!r.text.includes("￼"), "no placeholder character either");
});

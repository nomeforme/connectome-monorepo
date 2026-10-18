// @ts-check
/* connectome-house/test/external-guard.test.mjs — the quiet outbound
 * backstop for external rooms (mcpl/external-guard.mjs): phone numbers,
 * email addresses, platform ids and humans' display names never leave
 * for a seat whose config says `"audience": "external"`; internal seats
 * are never scanned. Every fixture is obviously fake. Own sandbox dirs,
 * set before the first import — order-safe, no network, no process. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "external-guard-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of ["HOUSE_RUNS_DIR", "HOUSE_PRIVATE_DIR", "HOUSE_COVENANTS_DIR"]) mkdirSync(process.env[d], { recursive: true });

const BEING = "zz-ext-being";
writeFileSync(join(process.env.HOUSE_COVENANTS_DIR, `${BEING}.md`), `---\nkind: testament\nhandle: ${BEING}\nposture: present\n---\n`);
writeFileSync(
  join(process.env.HOUSE_PRIVATE_DIR, "identity-map.json"),
  JSON.stringify({
    version: 1,
    entries: {
      "signal:00000000-0000-4000-8000-000000000001": { handle: "robin", display: "Robin Tester", home: "signal" },
      "discord:100000000000000001": { handle: "discord-abcdef", display: "Quillfeather", home: "discord" },
      "signal:abcdef123456": { handle: "signal-qq3rst", display: "Al", home: "signal" },
      "discord:100000000000000002": { handle: "discord-zz2zzz", display: "Admin", home: "discord" },
      "discord:100000000000000003": { handle: BEING, display: "Zz Ext Being", home: "discord" },
      "web:board-user-1": { handle: "web-xx2yyy", display: "Boardwalker", home: "web" },
    },
  }),
);

const { scanExternal, maskValue, isExternalSeat, blockedNotice } = await import("../src/mcpl/external-guard.mjs");
const { createSpeaker } = await import("../src/mcpl/speak.mjs");
const { validateServer } = await import("../src/mcpl/config.mjs");

const scan = (text) => scanExternal(text, { platform: "web", beingNames: [BEING] });
const kindsOf = (text) => [...new Set(scan(text).map((h) => h.kind))];

/* ---------------------------------------------------------------- phones */
test("phone: E.164, international and common local formats are caught", () => {
  for (const t of [
    "call me at +15555550123",
    "it's +1 555 555 0123 now",
    "+44 (0)20 7946 0958",
    "(555) 555-0123",
    "555-555-0123",
    "555.555.0123",
    "555 555 0123",
    "07700 900123",
    "07700900123",
    "020 7946 0958",
    "0044 20 7946 0958",
  ])
    assert.deepEqual(kindsOf(t), ["phone"], t);
});

test("phone: years, prices, versions, times, dates and counts never trigger", () => {
  for (const t of [
    "back in 2026 we tried it",
    "it cost $1,299.99, or 1299.99 EUR",
    "running Node v24.22.0 and lib 1.2.3",
    "build 10.0.19041 shipped",
    "meet at 12:30, or 12:30:45 sharp",
    "on 2026-10-17 and 17/10/2026 and 01-02-2026",
    "timestamp 1760000000 and 1760000000123",
    "pi is 3.14159265358979",
    "a crowd of 1,000,000 and 1 000 000",
    "from 2024-2026, up +100%",
    "pages 120-1350 of 800",
    "007 and 0.5 and 0800",
  ])
    assert.deepEqual(kindsOf(t), [], t);
});

/* ---------------------------------------------------------------- emails */
test("email: addresses are caught; mentions and spelled-out forms are not", () => {
  assert.deepEqual(kindsOf("write to alice@example.com"), ["email"]);
  assert.deepEqual(kindsOf("bob.smith+tag@mail.example.org!"), ["email"]);
  assert.deepEqual(kindsOf("ping @someone about it"), []);
  assert.deepEqual(kindsOf("alice at example dot com"), []);
});

/* ---------------------------------------------------------- platform ids */
test("platform ids: snowflakes, uuids, pseudonym handles and mapped ids are caught", () => {
  assert.deepEqual(kindsOf("user 123456789012345678 said"), ["platform-id"]);
  assert.deepEqual(kindsOf("aci 00000000-0000-4000-8000-0000000000ff"), ["platform-id"]);
  assert.deepEqual(kindsOf("that was signal-ab3cde"), ["platform-id"]);
  assert.deepEqual(kindsOf("that was discord-abcdef"), ["platform-id"], "a mapped pseudonym, even without a digit");
  assert.deepEqual(kindsOf("id abcdef123456 again"), ["platform-id"], "a human's literal id from the map");
});

test("platform ids: ordinary hyphenated words are not pseudonyms", () => {
  assert.deepEqual(kindsOf("a discord-server and a signal-driven design"), []);
  assert.deepEqual(kindsOf("signal-strength is fine"), []);
});

/* ----------------------------------------------------------------- names */
test("names: humans' displays and christened handles, any case, on word boundaries", () => {
  assert.deepEqual(kindsOf("robin tester was there"), ["name"]);
  assert.deepEqual(kindsOf("ROBIN_TESTER was there"), ["name"]);
  assert.deepEqual(kindsOf("Robin said hi"), ["name"]);
  assert.deepEqual(kindsOf("I talked with Quillfeather."), ["name"]);
});

test("names: substrings, short/generic names, beings and people public on this platform pass", () => {
  assert.deepEqual(kindsOf("Robinson Crusoe and a robin's nest... wait"), ["name"], "possessive is still the name");
  assert.deepEqual(kindsOf("Robinson Crusoe was alone"), []);
  assert.deepEqual(kindsOf("Al and the Admin"), []);
  assert.deepEqual(kindsOf(`I am ${BEING}, also Zz Ext Being`), []);
  assert.deepEqual(kindsOf("hello Boardwalker!"), [], "present on the external platform under that name");
});

test("whether a display is public depends on the seat's own platform", () => {
  const fromDiscord = scanExternal("hi Boardwalker and Quillfeather", { platform: "discord" });
  assert.deepEqual(fromDiscord.map((h) => h.value), ["Boardwalker"], "the web display is not public on discord; the discord one is");
  assert.deepEqual(kindsOf("hi Boardwalker and Quillfeather").length, 1);
});

/* ------------------------------------------------------ helpers & config */
test("maskValue never prints the value", () => {
  assert.equal(maskValue("+15555550123"), "+•••23");
  assert.equal(maskValue("Robin"), "R•••");
  assert.equal(maskValue(""), "•••");
});

test("isExternalSeat: only an explicit external audience (or an external adapter)", () => {
  assert.equal(isExternalSeat({ platform: "web", audience: "external" }), true);
  assert.equal(isExternalSeat({ platform: "discord" }), false);
  assert.equal(isExternalSeat({ platform: "signal", audience: "house" }), false);
  assert.equal(isExternalSeat(null), false);
});

test("config: audience is optional, validated, and a typo refuses the seat", () => {
  const BASE = { name: "ext-x", platform: "web", command: "node", being: BEING };
  assert.equal(/** @type {any} */ (validateServer(BASE)).audience, undefined);
  assert.equal(/** @type {any} */ (validateServer({ ...BASE, audience: "external" })).audience, "external");
  assert.equal(/** @type {any} */ (validateServer({ ...BASE, audience: "house" })).audience, "house");
  const bad = validateServer({ ...BASE, audience: "externall" });
  assert.equal(typeof bad, "string");
  assert.match(String(bad), /ext-x: audience/);
});

test("blockedNotice names kinds only", () => {
  const n = blockedNotice("web", BEING, ["phone", "name"]);
  assert.match(n, /a phone number and a person's name/);
  assert.match(n, /Say it again without that detail/);
});

/* ------------------------------------------------------------- the hook */
function stubSpeaker(roomId, cfgOver = {}) {
  mkdirSync(join(process.env.HOUSE_RUNS_DIR ?? "", roomId), { recursive: true });
  writeFileSync(join(process.env.HOUSE_RUNS_DIR ?? "", roomId, "frames.jsonl"), ""); // a real room always has its record
  const calls = [];
  const lines = [];
  const host = {
    state: { tools: [] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  };
  const cfg = { platform: "web", being: BEING, being_id: null, limit: 8000, observe_only: false, ...cfgOver };
  const speaker = createSpeaker({
    cfg: /** @type {any} */ (cfg),
    host,
    stats: { sent: 0, undelivered: 0 },
    say: (l) => lines.push(l),
    RUNS: process.env.HOUSE_RUNS_DIR ?? "",
    getAttachedAt: () => 0,
  });
  const read = (f) => {
    const p = join(process.env.HOUSE_RUNS_DIR ?? "", roomId, f);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  return { speaker, calls, lines, read };
}

test("external seat: a send naming a phone number is not delivered; recorded, logged masked, noted plainly", async () => {
  const { speaker, calls, lines, read } = stubSpeaker("ext-block-1", { audience: "external" });
  await speaker.speak("ext-block-1", "web:board:t1", "Robin Tester's number is +15555550123", { by: BEING, seq: 7 });
  assert.equal(calls.length, 0, "nothing reached the wire");
  const row = JSON.parse(read("external.jsonl").trim());
  assert.equal(row.delivered, false);
  assert.equal(row.reason, "external-guard");
  assert.equal(row.seq, 7);
  assert.doesNotMatch(read("external.jsonl"), /5555550123|Robin/);
  const guardLines = lines.filter((l) => l.includes("[external-guard]"));
  assert.equal(guardLines.length, 1, "exactly one log line");
  assert.match(guardLines[0], /\+•••23/);
  assert.doesNotMatch(guardLines[0], /5555550123|Robin Tester/);
  const frames = read("frames.jsonl");
  assert.match(frames, /contains a phone number and a person's name/);
  assert.doesNotMatch(frames, /5555550123|Robin/);
});

test("external seat: clean speech goes out unchanged", async () => {
  const { speaker, calls, read } = stubSpeaker("ext-clean-1", { audience: "external" });
  const text = "The house had a long argument about consciousness in 2026. Nobody won.";
  await speaker.speak("ext-clean-1", "web:board:t1", text, { by: BEING, seq: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.content, text);
  assert.doesNotMatch(read("external.jsonl"), /external-guard/);
});

test("external seat: an attachment whose filename carries an email is not sent", async () => {
  const { speaker, calls, read } = stubSpeaker("ext-media-1", { audience: "external" });
  await speaker.speakMedia("ext-media-1", "web:board:t1", { path: "/nowhere/x.png", filename: "alice@example.com.png" }, { by: BEING, seq: 3 });
  assert.equal(calls.length, 0);
  assert.match(read("external.jsonl"), /external-guard/);
});

test("internal seats are never scanned: Signal and Discord deliver the same text untouched", async () => {
  for (const platform of ["discord", "signal"]) {
    const room = `int-${platform}-1`;
    const { speaker, calls, lines, read } = stubSpeaker(room, { platform });
    const text = "Robin Tester: +15555550123, alice@example.com";
    await speaker.speak(room, `${platform}:g1:c1`, text, { by: BEING, seq: 1 });
    assert.equal(calls.length, 1, platform);
    assert.equal(calls[0].args.content, text, platform);
    assert.equal(lines.filter((l) => l.includes("external-guard")).length, 0, platform);
    assert.doesNotMatch(read("external.jsonl"), /external-guard/, platform);
  }
});

test("redelivery on an external seat is scanned too: a not-ready row naming an email is never resent", async () => {
  const { redeliverRoom } = await import("../src/mcpl/redeliver.mjs");
  const room = "ext-redeliver-1";
  const runDir = join(process.env.HOUSE_RUNS_DIR ?? "", room);
  mkdirSync(runDir, { recursive: true });
  const t = new Date().toISOString();
  writeFileSync(join(runDir, "frames.jsonl"), `${JSON.stringify({ seq: 4, t, type: "speech", by: BEING, inline: "mail alice@example.com" })}\n`);
  writeFileSync(
    join(runDir, "external.jsonl"),
    `${JSON.stringify({ t, direction: "out", platform: "web", delivered: false, reason: "not-ready", by: BEING, seq: 4 })}\n`,
  );
  const calls = [];
  const host = { state: { tools: [] }, callTool: async (name, args) => void calls.push({ name, args }) };
  const cfg = { platform: "web", being: BEING, being_id: null, limit: 8000, audience: "external" };
  await redeliverRoom({ cfg, host, say: () => {} }, "web:board:t1", runDir);
  assert.equal(calls.length, 0);
  assert.match(readFileSync(join(runDir, "external.jsonl"), "utf8"), /"reason":"external-guard"/);
});

test("the keeper's private list: extra names block, allow-phrases pass a name that is also a word", () => {
  const file = join(process.env.HOUSE_PRIVATE_DIR, "external-guard.json");
  const scan = (t) => scanExternal(t, { platform: "web" }).filter((h) => h.kind === "name").map((h) => h.value);
  assert.deepEqual(scan("Marigold says hi, from the rose garden"), [], "nothing listed yet");
  writeFileSync(file, JSON.stringify({ names: ["Marigold", "Rose", "zz"], allow_phrases: ["rose garden"] }));
  assert.deepEqual(scan("Marigold says hi"), ["Marigold"]);
  assert.deepEqual(scan("met in the Rose  Garden, as planned"), [], "the phrase passes, any case or spacing");
  assert.deepEqual(scan("ask Rose about it"), ["Rose"], "the name alone still blocks");
  assert.deepEqual(scan("zz top"), [], "under 3 chars is never a name");
  writeFileSync(file, "{not json");
  const t = statSync(file).mtimeMs + 5000;
  utimesSync(file, t / 1000, t / 1000);
  assert.deepEqual(scan("Marigold says hi"), [], "an unreadable list is empty");
  rmSync(file);
});

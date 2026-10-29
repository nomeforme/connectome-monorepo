// @ts-check
/* connectome-house/test/wakings.test.mjs — a being looks in on a room on
 * its own (wakings.mjs): who is offered it; wake_me resolves rooms, clamps
 * and clears; the first waking is the house's, one per active group room;
 * a due waking fires only into a quiet, active, open room where the being
 * is seated, unhushed and not busy, at most once per room gap; the line it
 * carries rides the turn, and the outcome is kept. Fixtures only. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "wakings-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "wakings-test-salt-0123456789abcdef";
for (const d of ["runs", "private", "covenants"]) mkdirSync(join(ROOT, d), { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const COV = process.env.HOUSE_COVENANTS_DIR;
writeTestament(COV, "oak", { speaksFor: "claude-sonnet-5", frontmatter: ["posture: resident"] });
writeTestament(COV, "fern", { speaksFor: "local.gguf", frontmatter: ["posture: resident", "endpoint: http://x:1/v1", "use_api_key: true"] });
writeTestament(COV, "elm", { speaksFor: "claude-3-opus-20240229", frontmatter: ["posture: resident", "use_api_key: true"] });
writeTestament(COV, "ash", { speaksFor: "claude-sonnet-5", frontmatter: ["posture: resident", "wakings: false"] });

const W = await import("../src/wakings.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { hushSet } = await import("../src/commands/store.mjs");
const { roomKeyForCls } = await import("../src/room-chain.mjs");

const TRACE = { frame() {}, result: (p) => ({ inline: typeof p === "string" ? p : JSON.stringify(p) }) };
const H = 3_600_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** a room on disk + in `open`, with frames at the given times */
function room(id, { title, stream = `signal:group:${id}`, beings = ["oak", "fern", "elm"], frames = [], seated = beings } = {}) {
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);
  mkdirSync(runDir, { recursive: true });
  const cls = { class: "wondering", owner: "oak", beings, participants: [], room: { platform: "signal", stream, title } };
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls));
  writeFileSync(join(runDir, "frames.jsonl"), frames.map((f, i) => JSON.stringify({ seq: i + 1, ...f })).join("\n") + "\n");
  const rec = { id, runDir, cls, status: "open", seats: new Map(seated.map((b) => [b, { being: b, send() {} }])), turns: new Map() };
  open.set(id, rec);
  return rec;
}
const human = (ms) => ({ t: iso(ms), type: "message", by: "signal-person1", text: "hi" });
const spoke = (ms, by = "oak") => ({ t: iso(ms), type: "speech", by, inline: "hello" });

test("who is offered wakings: OAuth Claude and local residents; the covenant can override", () => {
  assert.equal(W.wakingsEligible("oak"), true, "OAuth Claude");
  assert.equal(W.wakingsEligible("fern"), true, "a local endpoint");
  assert.equal(W.wakingsEligible("elm"), false, "an API-key route");
  assert.equal(W.wakingsEligible("ash"), false, "wakings: false");
  process.env.HOUSE_WAKINGS = "off";
  assert.equal(W.wakingsEligible("oak"), false, "HOUSE_WAKINGS=off");
  delete process.env.HOUSE_WAKINGS;
});

test("parseAfter, the line a waking carries", () => {
  assert.equal(W.parseAfter("8h"), 8 * H);
  assert.equal(W.parseAfter("2 days"), 48 * H);
  assert.equal(W.parseAfter("soon"), null);
  const own = W.wakingLine({ set_by: "being", reason: "see if the poem got finished", set_t: NOW }, 9 * H);
  assert.match(own, /a waking you set on 2026-10-29: "see if the poem got finished"/);
  assert.match(own, /quiet here for 9h/);
  assert.match(own, /end with no text at all/);
  assert.match(W.wakingLine({ set_by: "house" }, 30 * H), /the house's first .* wake_me sets when you look in next/);
});

test("roomPulse: last anyone, last person — beings, the house and interim speech don't count as a person", () => {
  const r = room("pulse-room", {
    title: "pulse",
    frames: [human(NOW - 10 * H), spoke(NOW - 5 * H), { t: iso(NOW - 4 * H), type: "message", by: "house", text: "[x]" }, { ...spoke(NOW - 3 * H), interim: true }],
  });
  const p = W.roomPulse(r.runDir);
  assert.equal(p.lastHuman, NOW - 10 * H);
  assert.equal(p.lastAny, NOW - 5 * H);
  open.delete("pulse-room");
});

test("wake_me: rooms by 'here', name or part of it; clamped; cleared; unknown rooms named back", async () => {
  room("aaaa1111-spa", { title: "༼つ cosmic spä ༽つ" });
  room("bbbb2222-test", { title: "test" });
  room("cccc3333-dm", { title: "dm", stream: "signal:dm:someone" });
  const tools = W.makeWakingTools({ now: () => NOW });
  const call = async (input, here = "bbbb2222-test") => {
    tools.beginTurn({ id: here, trace: TRACE }, "oak");
    return String((await tools.execute({ id: "c1", name: "wake_me", input })).content);
  };
  let out = await call({ after: "2d", reason: "check the poem", rooms: ["here", "cosmic spa"] });
  assert.match(out, /test: in 2d/);
  assert.match(out, /cosmic spä ༽つ: in 2d/);
  let s = W.readWakings("oak");
  assert.equal(s.alarms["bbbb2222-test"].due, NOW + 48 * H);
  assert.equal(s.alarms["aaaa1111-spa"].reason, "check the poem");
  out = await call({ after: "10m", reason: "too soon", rooms: ["here"] });
  assert.match(out, /kept within 6h/);
  assert.equal(W.readWakings("oak").alarms["bbbb2222-test"].due, NOW + 6 * H);
  out = await call({ after: "1d", reason: "x", rooms: ["dm", "nowhere"] });
  assert.match(out, /not found among your group rooms: dm, nowhere/, "a DM is never a waking room");
  out = await call({ after: "never", reason: "", rooms: ["here"] });
  assert.match(out, /test: cleared/);
  s = W.readWakings("oak");
  assert.equal(s.alarms["bbbb2222-test"], undefined);
  assert.ok(s.alarms["aaaa1111-spa"], "only the named room cleared");
  tools.beginTurn({ id: "bbbb2222-test", trace: TRACE }, "elm");
  assert.match(String((await tools.execute({ id: "c2", name: "wake_me", input: { after: "1d", reason: "x", rooms: ["here"] } })).content), /not offered/);
  for (const id of ["aaaa1111-spa", "bbbb2222-test", "cccc3333-dm"]) open.delete(id);
});

test("tick: the first waking is the house's, one per active group room; then fires only into a quiet, active room, once per gap", async () => {
  const active = room("dddd4444-live", { title: "live", beings: ["fern"], frames: [human(NOW - 20 * H), spoke(NOW - 8 * H, "fern")] });
  room("eeee5555-stale", { title: "stale", beings: ["fern"], frames: [human(NOW - 5 * 24 * H)] });
  const turns = [];
  const beginTurn = (rec, handle, opts) => {
    turns.push({ room: rec.id, handle, line: opts?.waking });
    return Promise.resolve({ kind: "done", spoke: false });
  };
  W.tickWakings({ beginTurn, now: () => NOW, rng: () => 0 });
  let s = W.readWakings("fern");
  assert.ok(s.seeded["dddd4444-live"], "seeded in the active room");
  assert.equal(s.seeded["eeee5555-stale"], undefined, "not in a room no person spoke in for days");
  // rng 0 → due now; quiet 8h ≥ 6h → it fires on this same pass
  assert.equal(turns.length, 1);
  assert.match(turns[0].line, /the house's first for you in this room; nobody has addressed you; it has been quiet here for 8h/);
  await new Promise((r) => setImmediate(r));
  s = W.readWakings("fern");
  assert.equal(s.alarms["dddd4444-live"], undefined, "one-shot");
  assert.equal(s.history.at(-1).outcome, "silent");
  assert.equal(s.history.at(-1).set_by, "house", "the first one was the house's");
  // its own alarm, due, but inside the room gap → waits
  s.alarms["dddd4444-live"] = { due: NOW, reason: "look again", set_t: NOW - H, set_by: "being" };
  writeFileSync(join(process.env.HOUSE_PRIVATE_DIR, "fern", "wakings.json"), JSON.stringify(s));
  W.tickWakings({ beginTurn, now: () => NOW + H });
  assert.equal(turns.length, 1, "room gap holds");
  // past the gap, but the room is mid-conversation → waits for the quiet
  writeFileSync(join(active.runDir, "frames.jsonl"), [human(NOW + 24 * H)].map((f) => JSON.stringify(f)).join("\n") + "\n");
  W.tickWakings({ beginTurn, now: () => NOW + 25 * H });
  assert.equal(turns.length, 1, "not into a live conversation");
  // hushed → waits; unhushed and quiet → fires with its own reason
  hushSet(roomKeyForCls(active.cls, active.id), "fern", NOW + 40 * H, { by: "oak", reason: "loop" });
  W.tickWakings({ beginTurn, now: () => NOW + 31 * H });
  assert.equal(turns.length, 1, "a hushed being waits");
  W.tickWakings({ beginTurn, now: () => NOW + 41 * H });
  assert.equal(turns.length, 2);
  assert.match(turns[1].line, /a waking you set on .*"look again".*quiet here for 17h/);
  open.delete("dddd4444-live");
  open.delete("eeee5555-stale");
});

test("tick: an unseated or busy being waits; a closed room waits; an alarm 14 days past due lapses", () => {
  const r = room("ffff6666-busy", { title: "busy", beings: ["oak"], seated: [], frames: [human(NOW - 10 * H)] });
  const st = { alarms: { "ffff6666-busy": { due: NOW - H, reason: "x", set_t: NOW - 2 * H, set_by: "being" }, "gone-room": { due: NOW - 15 * 24 * H, reason: "y", set_t: 0, set_by: "being" } }, seeded: { "ffff6666-busy": 1 }, history: [] };
  mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "oak"), { recursive: true });
  writeFileSync(join(process.env.HOUSE_PRIVATE_DIR, "oak", "wakings.json"), JSON.stringify(st));
  const turns = [];
  const beginTurn = (rec, handle) => (turns.push(handle), Promise.resolve({ kind: "done", spoke: true }));
  W.tickWakings({ beginTurn, now: () => NOW });
  assert.equal(turns.length, 0, "no seat, no waking");
  r.seats.set("oak", { being: "oak", send() {} });
  r.turns.set("oak", { turnId: "t" });
  W.tickWakings({ beginTurn, now: () => NOW });
  assert.equal(turns.length, 0, "a turn in flight, no waking");
  r.turns.clear();
  r.status = "rested";
  W.tickWakings({ beginTurn, now: () => NOW });
  assert.equal(turns.length, 0, "a room not open now waits");
  const s = W.readWakings("oak");
  assert.ok(s.alarms["ffff6666-busy"], "still kept for later");
  assert.equal(s.alarms["gone-room"], undefined, "lapsed");
  assert.equal(s.history.at(-1).outcome, "lapsed");
  open.delete("ffff6666-busy");
});

test("the waking line rides the turn only — sent to the being, never written to the record; the address names wake_me", async () => {
  const { beginTurn } = await import("../src/room-turn.mjs");
  const { readFileSync } = await import("node:fs");
  const r = room("gggg7777-wire", { title: "wire", beings: ["oak"], frames: [human(NOW - 10 * H)] });
  const sent = [];
  r.seats.set("oak", { being: "oak", send: (m) => sent.push(m) });
  const before = readFileSync(join(r.runDir, "frames.jsonl"), "utf8");
  void beginTurn(r, "oak", { waking: "[a waking — test line]" });
  const begin = sent.find((m) => m.type === "turn.begin");
  assert.ok(begin, "turn.begin sent");
  const last = begin.context.conversation.at(-1);
  assert.equal(last.participant, "house");
  assert.equal(last.content[0].text, "[a waking — test line]");
  assert.ok(begin.covenant.tools.includes("wake_me"));
  assert.equal(readFileSync(join(r.runDir, "frames.jsonl"), "utf8"), before, "nothing recorded");
  const { systemFor } = await import("../src/walk-address.mjs");
  const sys = systemFor({ being: "oak", covenant: begin.covenant, context: begin.context });
  assert.match(sys, /wake_me \(after, reason, rooms\)/);
  const { wakingText } = await import("../src/walk-address-strings.mjs");
  assert.equal(wakingText(["fetch"]), null, "no wake_me, no line");
  r.turns.clear();
  open.delete("gggg7777-wire");
});

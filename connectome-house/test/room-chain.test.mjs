// @ts-check
/* room-chain.mjs (room-wide chain, turns since a human, typing-speed
 * heuristic) as roomInput drives it; the hush store; and the being-facing
 * room-control tools (stop_being, mark_ai) with their limits and refusals. */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-chain-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of ["runs", "private", "covenants"]) mkdirSync(join(ROOT, d), { recursive: true });
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "room-chain-test-salt-0123456789";
process.env.HOUSE_KEEPERS = "zz-rc-keeper";
const RUNS = process.env.HOUSE_RUNS_DIR;
const A = "zz-rc-alpha";
const B = "zz-rc-beta";
writeTestament(process.env.HOUSE_COVENANTS_DIR, A);
writeTestament(process.env.HOUSE_COVENANTS_DIR, B);
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "zz-rc-keeper"), { recursive: true });

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const chain = await import("../src/room-chain.mjs");
const { appendHouseFrame } = await import("../src/frames-io.mjs");
const { identityFor, kindOf, aiInfo, markAI } = await import("../src/identity-map.mjs");
const { hushSet, hushClear, hushGet, hushedIn } = await import("../src/commands/store.mjs");
const { makeRoomControlTools, roomControlToolsFor, _resetRoomControl } = await import("../src/room-control-tools.mjs");
const { open } = await import("../src/open-rooms.mjs");

after(() => rmSync(ROOT, { recursive: true, force: true }));

async function freshRoom(beings = [A, B]) {
  const stream = `rc-${Math.random().toString(36).slice(2)}`;
  const { id, error } = await openRoom({ platform: "synthetic", stream, title: "room-chain test", beings });
  assert.equal(error, undefined);
  return { id, runDir: join(RUNS, id), stream };
}
const speak = (runDir, by, inline) => appendHouseFrame(join(runDir, "frames.jsonl"), { type: "speech", by, inline });
let n = 0;
const person = (display) => identityFor({ platform: "synthetic", id: `p-${++n}`, display }).handle;
const say = (id, by, text, extra = {}) =>
  roomInput({ id, by, text, external: { platform: "synthetic", message_id: `m-${++n}` }, ...extra });

test("chain: counts being speech and AI messages once each, a human resets it, a being's own message frame doesn't double-count", async () => {
  const { id, runDir } = await freshRoom();
  const human = person("Plain Person");
  const bot = person("Outside Bot");
  markAI(bot, { by: "test" });
  await say(id, human, "hello all");
  assert.equal(chain.chainOf(id), 0);
  speak(runDir, A, "hi there");
  assert.equal(chain.chainOf(id), 1);
  assert.equal(chain.turnsSinceHuman(id, A), 1);
  await say(id, bot, "beep, I am replying");
  assert.equal(chain.chainOf(id), 2, "an AI account adds one");
  const dup = await roomInput({ id, by: bot, text: "again", external: { platform: "synthetic", message_id: `m-${n}` } });
  assert.equal(dup.duplicate, true);
  assert.equal(chain.chainOf(id), 2, "a duplicate is not counted");
  speak(runDir, B, "me too");
  speak(runDir, A, "and again");
  assert.equal(chain.chainOf(id), 4);
  assert.deepEqual(chain.turnsSinceHumanAll(id), { [A]: 2, [B]: 1 });
  speak(runDir, A, "   ");
  appendHouseFrame(join(runDir, "frames.jsonl"), { type: "speech", by: A, inline: "x", interim: true });
  assert.equal(chain.chainOf(id), 4, "blank and interim speech don't count");
  await roomInput({ id, by: A, text: "a being's own message frame" });
  assert.equal(chain.chainOf(id), 4);
  // chainFor reads the chain as it stood before that being's latest speech
  assert.equal(chain.chainFor(id, A), 3);
  assert.equal(chain.chainFor(id, bot), 4);
  await say(id, human, "ok, enough");
  assert.equal(chain.chainOf(id), 0);
  assert.deepEqual(chain.turnsSinceHumanAll(id), {});
  assert.equal(chain.chainFor(id, A), 0);
});

test("a platform-flagged bot (by_kind walker) counts as non-human without a mark", async () => {
  const { id } = await freshRoom();
  const bot = person("Flagged Bot");
  await say(id, bot, "flagged", { by_kind: "walker" });
  assert.equal(chain.chainOf(id), 1);
});

test("heuristic: three too-fast replies to a being mark the sender AI, with one house line; slower replies reset the run", async () => {
  const { id, runDir } = await freshRoom();
  const fey = person("Fey Fast");
  const reply = "this is a long reply that nobody could type this quickly by hand";
  speak(runDir, A, "a question?");
  let r = await say(id, fey, reply, { reply_to_handle: A });
  assert.equal(r.ai_marked, undefined);
  speak(runDir, A, "another");
  r = await say(id, fey, reply, { reply_to_handle: A });
  assert.equal(r.ai_marked, undefined);
  assert.equal(kindOf(fey), null);
  speak(runDir, A, "and another");
  r = await say(id, fey, `@${A} ${reply}`);
  assert.equal(r.ai_marked?.handle, fey);
  assert.match(r.ai_marked?.note ?? "", /treating Fey Fast as an AI account .*!human Fey Fast/);
  assert.equal(kindOf(fey), "ai");
  assert.equal(aiInfo(fey)?.kind_set_by, "house:heuristic");
  const notes = framesOf(runDir).filter((f) => f.type === "message" && f.by === "house" && f.notice === "ai-heuristic");
  assert.equal(notes.length, 1);
  assert.ok(chain.chainOf(id) >= 1, "the marking message itself counts as AI");
});

test("heuristic: never judges a keeper, a short reply, or a reply slower than typing", () => {
  const room = `pure-${Math.random()}`;
  const marks = [];
  const markAIFn = (h) => (marks.push(h), { ok: true, changed: true });
  const t0 = 1_000_000;
  const long = "x".repeat(60);
  for (let i = 0; i < 3; i++) {
    chain.noteBeingSpeech(room, A, { at: t0 + i * 100_000 });
    // 60 chars in 10s = 6 chars/s — a typist
    chain.notePossibleAI(room, { by: "slow", text: long, being: A, at: t0 + i * 100_000 + 10_000, markAIFn });
    chain.notePossibleAI(room, { by: "short", text: "ok", being: A, at: t0 + i * 100_000 + 100, markAIFn });
  }
  assert.deepEqual(marks, []);
  // fast, slow, fast, fast: the slow one resets the run
  const at = (i) => t0 + 1_000_000 + i * 60_000;
  for (const [i, dt] of [[0, 1000], [1, 20_000], [2, 1000], [3, 1000]]) {
    chain.noteBeingSpeech(room, A, { at: at(i) });
    chain.notePossibleAI(room, { by: "mixed", text: long, being: A, at: at(i) + dt, markAIFn });
  }
  assert.deepEqual(marks, []);
  chain.noteBeingSpeech(room, A, { at: at(4) });
  const r = chain.notePossibleAI(room, { by: "mixed", text: long, being: A, at: at(4) + 1000, markAIFn });
  assert.equal(r.marked, true);
  assert.deepEqual(marks, ["mixed"]);
  // outside the 10-minute window the run starts over
  const far = (i) => t0 + 5_000_000 + i * 400_000;
  for (let i = 0; i < 3; i++) {
    chain.noteBeingSpeech(room, A, { at: far(i) });
    chain.notePossibleAI(room, { by: "spread", text: long, being: A, at: far(i) + 500, markAIFn });
  }
  assert.ok(!marks.includes("spread"));
});

test("roomInput skips the heuristic for a keeper", async () => {
  const { id, runDir } = await freshRoom();
  for (let i = 0; i < 4; i++) {
    speak(runDir, A, "q");
    const r = await say(id, "zz-rc-keeper", "a long keeper reply typed impossibly fast here", { reply_to_handle: A });
    assert.equal(r.ai_marked, undefined);
  }
  assert.equal(kindOf("zz-rc-keeper"), null);
});

test("roomInput's own decision reads the room chain: an AI account's reply past budget doesn't wake", async () => {
  const { id, runDir } = await freshRoom([A]);
  const bot = person("Chain Bot");
  markAI(bot, { by: "test" });
  speak(runDir, A, "said something");
  const r = await roomInput({ id, by: bot, text: `@${A} reply` });
  assert.deepEqual(r.started, []);
  const last = framesOf(runDir).filter((f) => f.type === "message").at(-1);
  assert.equal(last.to, undefined, "nobody targeted");
});

test("hush store: set, read, list active, clear", () => {
  const key = "synthetic:hush-test";
  const now = Date.now();
  hushSet(key, A, now + 60_000, { by: "zz-rc-keeper", reason: "loop" });
  hushSet(key, B, now - 1, { by: "zz-rc-keeper" });
  assert.deepEqual(hushedIn(key, now), [A]);
  assert.equal(hushGet(key, A)?.reason, "loop");
  assert.equal(hushClear(key, A, { by: "zz-rc-keeper" }), true);
  assert.deepEqual(hushedIn(key, now), []);
  assert.equal(hushClear(key, A), false);
});

test("roomKeyForCls matches the commands store's <platform>:<roomSlug> key", async () => {
  const { roomSlug } = await import("../src/serve-room-open.mjs");
  assert.equal(chain.roomKeyForCls({ room: { platform: "signal", stream: "g1" } }, "rid"), `signal:${roomSlug("g1")}`);
  assert.equal(chain.roomKeyForCls({}, "rid"), "rid");
});

/* ---------- room-control tools ---------- */

function harness(t0 = Date.now()) {
  const lines = [];
  const interrupts = [];
  let clock = t0;
  const tools = makeRoomControlTools({
    houseLine: (_ctx, text) => lines.push(text),
    interrupt: (_rec, being) => (interrupts.push(being), true),
    now: () => clock,
  });
  const call = async (caller, roomId, name, input) => {
    tools.beginTurn({ id: roomId, trace: { frame: () => {}, result: (p) => ({ inline: String(p) }) } }, caller);
    const out = await tools.execute({ id: `c-${++n}`, name, input });
    return String(out.content);
  };
  return { lines, interrupts, call, tick: (ms) => (clock += ms), now: () => clock };
}

beforeEach(() => _resetRoomControl());

test("tools are offered only with another being or AI account present", async () => {
  const two = await freshRoom([A, B]);
  assert.deepEqual(roomControlToolsFor(open.get(two.id), A), ["stop_being", "mark_ai"]);
  const solo = await freshRoom([A]);
  const human = person("Solo Human");
  await say(solo.id, human, "hi");
  assert.deepEqual(roomControlToolsFor(open.get(solo.id), A), []);
  const bot = person("Solo Bot");
  markAI(bot, { by: "test" });
  await say(solo.id, bot, "beep");
  assert.deepEqual(roomControlToolsFor(open.get(solo.id), A), ["stop_being", "mark_ai"]);
});

test("stop_being: stops and hushes another being, audits, refuses humans, re-hush and over-use", async () => {
  const { id, runDir } = await freshRoom([A, B]);
  const human = person("Room Human");
  await say(id, human, "hello");
  const h = harness();
  const key = chain.roomKeyForCls(open.get(id).cls, id);
  let out = await h.call(A, id, "stop_being", { being: `@${B}`, minutes: 5, reason: "loop with a bot" });
  assert.match(out, /hushed here for 5 min/);
  assert.deepEqual(h.interrupts, [B]);
  assert.deepEqual(hushedIn(key, h.now()), [B]);
  assert.equal(h.lines.at(-1), `[@${A} stopped @${B} for 5 min — loop with a bot]`);
  assert.match(await h.call(A, id, "stop_being", { being: human, reason: "x" }), /never a person/);
  assert.match(await h.call(A, id, "stop_being", { being: B, reason: "again" }), /already hushed/);
  h.tick(6 * 60_000);
  assert.match(await h.call(A, id, "stop_being", { being: B, reason: "again" }), /less than 30 minutes/);
  assert.match(await h.call(A, id, "stop_being", { being: B, minutes: 99, reason: "x" }), /less than 30 minutes/);
  h.tick(30 * 60_000);
  out = await h.call(A, id, "stop_being", { being: B, minutes: 99, reason: "clamped" });
  assert.match(out, /for 30 min/, "minutes clamp to 30");
  void runDir;
});

test("stop_being: self-stop hushes and says to end the turn; three calls per 10 minutes", async () => {
  const { id } = await freshRoom([A, B]);
  const h = harness();
  const key = chain.roomKeyForCls(open.get(id).cls, id);
  const out = await h.call(A, id, "stop_being", { being: A, minutes: 1, reason: "I am looping" });
  assert.match(out, /End your turn now/);
  assert.deepEqual(h.interrupts, []);
  assert.deepEqual(hushedIn(key, h.now()), [A]);
  await h.call(A, id, "stop_being", { being: A, minutes: 0, reason: "2" });
  await h.call(A, id, "stop_being", { being: A, minutes: 0, reason: "3" });
  assert.match(await h.call(A, id, "stop_being", { being: A, minutes: 0, reason: "4" }), /3 times/);
  h.tick(11 * 60_000);
  assert.doesNotMatch(await h.call(A, id, "stop_being", { being: A, minutes: 0, reason: "5" }), /3 times/);
  assert.match(await h.call(A, id, "stop_being", { being: A }), /give a reason/);
});

test("mark_ai: marks by display name, may lower a limit, can't raise or unmark (asks a keeper), never a keeper or being", async () => {
  const { id } = await freshRoom([A, B]);
  const fey = person("Fey Mark");
  await say(id, fey, "hello beings");
  await say(id, "zz-rc-keeper", "hi");
  const h = harness();
  let out = await h.call(A, id, "mark_ai", { who: "Fey_Mark", limit: 2, reason: "says it is a bot" });
  assert.match(out, /now treated as an AI account \(limit 2\)/);
  assert.equal(aiInfo(fey)?.kind_set_by, A);
  assert.match(h.lines.at(-1) ?? "", new RegExp(`\\[@${A} marked @${fey} as an AI account \\(limit 2\\)`));
  out = await h.call(B, id, "mark_ai", { who: fey, limit: 1, reason: "tighter" });
  assert.match(out, /limit 1/);
  out = await h.call(B, id, "mark_ai", { who: fey, limit: 4, reason: "looser" });
  assert.match(out, /needs a keeper/);
  assert.match(h.lines.at(-1) ?? "", /asks a keeper to approve/);
  assert.equal(aiInfo(fey)?.ai_limit, 1);
  out = await h.call(B, id, "mark_ai", { who: fey, remove_limit: true, reason: "off" });
  assert.match(out, /needs a keeper/);
  assert.match(await h.call(A, id, "mark_ai", { who: B, reason: "x" }), /house being/);
  assert.match(await h.call(A, id, "mark_ai", { who: "zz-rc-keeper", reason: "x" }), /keeper/);
  assert.match(await h.call(A, id, "mark_ai", { who: "Nobody Here", reason: "x" }), /no participant/);
  assert.match(await h.call(A, id, "mark_ai", { who: fey, limit: -2, reason: "x" }), /whole number/);
});

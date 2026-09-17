// @ts-check
/* connectome-house/test/room-turn-settings.test.mjs — harness-port P-A
 * (parity round, 2026-09-17), mission task 2: room-turn.mjs's own
 * consumers for settings the command lane stores but nothing read back
 * before this round (commands/store.mjs's own header) — `!mcf`/`!mmf`/
 * `!h-default` trimming `renderConversation`'s own rendered slice, and
 * `!mt`/`!sysprompt` riding `covenantExcerpt` into `turn.begin`.
 *
 * A REAL platform room (`platform: "discord"`, a real stream) is used
 * throughout, NOT a synthetic one — commands/registry.mjs persists
 * mcf/h-default under `` `${platform}:${roomSlug(stream)}` `` (mcpl/
 * seat.mjs's own `roomKeyOf`), which is NOT a room's own run `id` (a
 * `randomUUID()`) — this file's own fixture reproduces that same key so
 * its assertions exercise the exact seam a live seat would (see room-
 * turn.mjs's own `commandRoomKeyFor`, this task's report). */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-turn-settings-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { renderConversation, covenantExcerpt, beginTurn, applyContinue } = await import("../src/room-turn.mjs");
const { roomSlug } = await import("../src/serve-room-open.mjs");
const { memorySet, roomSettingsSet, beingSettingsSet, resetMemory } = await import("../src/commands/store.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { SeatClient } = await import("@connectome/seat-client");

beforeEach(() => resetMemory());

/** open one real platform room and return its record plus the SAME
 * commands/registry.mjs room key a live seat would compute for it. */
async function realRoom(streamSuffix) {
  const stream = `room-turn-settings-${streamSuffix}`;
  const { id, error } = await openRoom({
    platform: "discord",
    stream,
    title: "room-turn-settings.test.mjs fixture",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const roomKey = `discord:${roomSlug(stream)}`;
  return { rec: open.get(id), roomKey, id };
}

// ---------- !mcf / !mmf / !h-default: renderConversation's own trim ----------

test("renderConversation: with no settings at all, nothing is trimmed (well under the 400 server default)", async () => {
  const { rec } = await realRoom("mcf-default");
  for (let i = 0; i < 5; i++) await roomInput({ id: rec.id, by: "mara", text: `ambient message ${i}` });
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 5);
});

test("!mcf's own stream-wide '*' override trims renderConversation's own slice to the last N", async () => {
  const { rec, roomKey } = await realRoom("mcf-stream-wide");
  for (let i = 0; i < 6; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  memorySet(roomKey, "context.max_frames:*", 3); // exactly what registry.mjs's bare `!mcf 3` stores
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 3, "trimmed to the stream-wide override");
});

test("!mcf's own @bot-scoped override wins over the stream-wide one, for that being only", async () => {
  const { rec, roomKey } = await realRoom("mcf-bot-scoped");
  for (let i = 0; i < 8; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  memorySet(roomKey, "context.max_frames:*", 5);
  memorySet(roomKey, "context.max_frames:aria", 2); // `@aria !mcf 2`
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 2, "aria's own per-bot override wins over the stream-wide 5");
});

test("!mmf is GLOBAL (not per-room) and caps alongside !mcf — whichever is smaller wins", async () => {
  const { rec, roomKey } = await realRoom("mmf-global");
  for (let i = 0; i < 8; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  memorySet(roomKey, "context.max_frames:*", 6);
  memorySet(null, "memory.max_frames", 3); // !mmf 3, axon-wide
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 3, "the smaller of mcf(6)/mmf(3) wins");

  // a DIFFERENT room, no mcf override at all, still sees mmf's global cap.
  const { rec: rec2 } = await realRoom("mmf-global-2");
  for (let i = 0; i < 8; i++) await roomInput({ id: rec2.id, by: "mara", text: `msg ${i}` });
  assert.equal(renderConversation(rec2, "aria").length, 3, "mmf's cap is global, reaching a room that never set mcf at all");
});

test("!h-default further trims to the last (N + 1) messages, ON TOP of whatever mcf/mmf already allowed", async () => {
  const { rec, roomKey } = await realRoom("hdefault-trim");
  for (let i = 0; i < 10; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  roomSettingsSet(roomKey, "context.history_default:aria", 2); // !h-default 2, persisted
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 3, "N=2 history + the newest message = 3, well under the untrimmed 10");
});

test("!h-default is scoped per (being, room) — a different being in the same room is untouched", async () => {
  const { rec, roomKey } = await realRoom("hdefault-per-being");
  for (let i = 0; i < 6; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  roomSettingsSet(roomKey, "context.history_default:vallynn", 1);
  const conv = renderConversation(rec, "aria");
  assert.equal(conv.length, 6, "aria has no h-default of its own here — untouched");
});

// ---------- !mt / !sysprompt: covenantExcerpt riding turn.begin ----------

test("covenantExcerpt: !mt's own GLOBAL per-being override rides as maxTokens, absent when unset", async () => {
  const { rec } = await realRoom("mt-covenant");
  assert.equal(covenantExcerpt(rec.id, "aria").maxTokens, undefined, "unset — the property is absent entirely, never a fabricated default");
  memorySet(null, "max_tokens:aria", 500); // !mt 500
  assert.equal(covenantExcerpt(rec.id, "aria").maxTokens, 500);

  // a DIFFERENT room's covenantExcerpt sees the SAME value — global, not per-room.
  const { rec: rec2 } = await realRoom("mt-covenant-2");
  assert.equal(covenantExcerpt(rec2.id, "aria").maxTokens, 500);
});

test("covenantExcerpt: !sysprompt's in-memory (temp/override, current process) tier wins over the being-persisted tier", async () => {
  const { rec } = await realRoom("sysprompt-covenant");
  assert.equal(covenantExcerpt(rec.id, "aria").systemPromptOverride, undefined);
  beingSettingsSet("aria", "sysprompt", "persisted overlay"); // a PRIOR process's !sysprompt override
  assert.equal(covenantExcerpt(rec.id, "aria").systemPromptOverride, "persisted overlay", "falls back to the persisted tier when memory has nothing this process");
  memorySet(null, "sysprompt:aria", "temp overlay this session"); // !sysprompt temp, THIS process
  assert.equal(covenantExcerpt(rec.id, "aria").systemPromptOverride, "temp overlay this session", "the in-memory tier wins — matches the fork's own single running field");
});

// ---------- !continue / m continue: a continue:true turn.begin ----------

test("applyContinue: beginTurn is called with {continue:true}, and the being's own seat receives it on the wire", async (t) => {
  const { rec, id } = await realRoom("continue-flag");
  const sockDir = mkdtempSync(join(tmpdir(), "room-turn-settings-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const client = new SeatClient({ path: sockPath, seatId: "aria-continue", being: "aria", room: id });
  /** @type {Record<string, unknown>[]} */
  const seen = [];
  client.on("turn.begin", (m) => seen.push(m));
  await client.connect();
  t.after(() => client.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  const result = applyContinue(open.get(id), "aria");
  assert.ok(result, "a turn genuinely began");

  await waitFor(() => (seen.length >= 1 ? true : null));
  assert.equal(seen[0].continue, true, "the wire turn.begin carries continue:true");

  // idempotent-ish: a second call while a turn is already open is a no-op.
  assert.equal(applyContinue(open.get(id), "aria"), null);
});

test("applyContinue on a room with no seat at all: a silent no-op (null), never a throw", async () => {
  const { rec, id } = await realRoom("continue-no-seat");
  assert.equal(applyContinue(open.get(id), "aria"), null);
});

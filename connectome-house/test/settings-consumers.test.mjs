// @ts-check
/* connectome-house/test/settings-consumers.test.mjs — harness-port Q1-C,
 * 2026-09-18 (mission task 2): the two settings-consumers this task adds
 * that room-turn-settings.test.mjs (P-A's own file, mcf/mmf/h-default/mt/
 * sysprompt/continue) does not cover —
 *
 * 1. `!split` (C9, Signal only): mcpl/speak.mjs's own `speak()` reads
 *    commands/store.mjs's room-scoped `split` setting live, at send time,
 *    keyed by `` `${platform}:${roomSlug(stream)}` `` (mcpl/seat.mjs's own
 *    `roomKeyOf`) — exercised directly against `createSpeaker`, no socket
 *    needed (speak.mjs's own boundary is `host.callTool`).
 * 2. `!autotrigger` (C14): room-turn.mjs's `closeTurn` now applies
 *    src/autotrigger.mjs's `applyAutotriggerOnTurnClose` on every ordinary
 *    ("done") close — end to end, through a REAL socket seat and a
 *    scripted being (MockBeing's own per-turn script QUEUE), proving a
 *    being that keeps calling `continue_substream` gets reactivated with
 *    no new external trigger, and stops the moment it doesn't (test/
 *    autotrigger.test.mjs already covers the storage/decision seam in
 *    isolation; this file is the wiring's own end-to-end proof). */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing, SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "settings-consumers-"));
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
const { roomSlug } = await import("../src/serve-room-open.mjs");
const { memorySet, memoryGet, resetMemory } = await import("../src/commands/store.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { createSpeaker } = await import("../src/mcpl/speak.mjs");

beforeEach(() => resetMemory());

// ---------- !split (C9): speak.mjs's own live read ----------

/** a bare speaker: a stub host (records every callTool), a real RUNS dir
 * (recordOutbound's own sidecar needs the room's own directory to exist),
 * no socket, no open room registry entry needed (only touched on an
 * undelivered send, which this suite never exercises). */
function stubSpeaker(platform, roomId) {
  mkdirSync(join(process.env.HOUSE_RUNS_DIR, roomId), { recursive: true });
  const calls = [];
  const host = {
    state: { tools: [] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  };
  const cfg = { platform, being: "aria", being_id: null, limit: 4000, observe_only: false };
  const speaker = createSpeaker({ cfg, host, stats: { sent: 0, undelivered: 0 }, say: () => {}, RUNS: process.env.HOUSE_RUNS_DIR });
  return { speaker, calls };
}

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `paragraph number ${i} of this long speech, padded with words`).join("\n\n");

test("!split unset: Signal's own soft default (400) splits a long speech into several chunks", async () => {
  const { speaker, calls } = stubSpeaker("signal", "split-default");
  await speaker.speak("split-default", "signal:group:abc", LONG_TEXT, { by: "aria" });
  assert.ok(calls.length > 1, `expected several chunks under the 400-char default, got ${calls.length}`);
  for (const c of calls) assert.ok(c.args.content.length <= 400, "no chunk should exceed the 400-char soft default");
});

test("!split native (0): the SAME room's speech now goes out as ONE chunk, bounded only by the hard platform limit", async () => {
  const roomKey = `signal:${roomSlug("signal:group:abc")}`;
  memorySet(roomKey, "split", 0);
  const { speaker, calls } = stubSpeaker("signal", "split-native");
  await speaker.speak("split-native", "signal:group:abc", LONG_TEXT, { by: "aria" });
  assert.equal(calls.length, 1, "native/off means no soft splitting at all");
});

test("!split N: a smaller custom threshold splits into more, smaller chunks than the default", async () => {
  const roomKey = `signal:${roomSlug("signal:group:xyz")}`;
  memorySet(roomKey, "split", 60);
  const { speaker, calls } = stubSpeaker("signal", "split-custom");
  await speaker.speak("split-custom", "signal:group:xyz", LONG_TEXT, { by: "aria" });
  assert.ok(calls.length > 1);
  for (const c of calls) assert.ok(c.args.content.length <= 60, `chunk exceeded the custom 60-char threshold: ${c.args.content.length}`);
});

test("!split is Signal-only: the same room key set on a discord speaker changes nothing (byte-exact fork chunking)", async () => {
  const roomKey = `discord:${roomSlug("general")}`;
  memorySet(roomKey, "split", 10); // would be a tiny threshold if (wrongly) applied
  const { speaker, calls } = stubSpeaker("discord", "split-discord");
  await speaker.speak("split-discord", "general", LONG_TEXT, { by: "aria" });
  assert.ok(calls.length >= 1);
  // discord's own splitter chunks at cfg.limit (4000 here), never at 10 —
  // proof the room's `split` setting was never consulted for this platform.
  assert.ok(calls.some((c) => c.args.content.length > 10), "discord chunking must ignore the Signal-only !split setting");
});

// ---------- !autotrigger (C14): the turn-close loop, end to end ----------

/** open one real (discord-shaped) room and return its record plus the
 * SAME command-lane room key registry.mjs's `!autotrigger` would persist
 * under (mirrors room-turn-settings.test.mjs's own `realRoom` helper). */
async function realRoom(streamSuffix) {
  const stream = `autotrigger-${streamSuffix}`;
  const { id, error } = await openRoom({
    platform: "discord",
    stream,
    title: "settings-consumers.test.mjs fixture",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const roomKey = `discord:${roomSlug(stream)}`;
  return { rec: open.get(id), roomKey, id };
}

test("a being that keeps calling continue_substream and speaking gets reactivated with no new external trigger; stops the moment it doesn't", async (t) => {
  const { roomKey, id } = await realRoom("reactivates");
  memorySet(roomKey, "autotrigger.on", true);
  memorySet(roomKey, "autotrigger.max_speech_only", 5);

  const sockDir = mkdtempSync(join(tmpdir(), "settings-consumers-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const being = new MockBeing({
    path: sockPath,
    seatId: "aria-autotrigger",
    being: "aria",
    room: id,
    script: [
      [
        { kind: "tool.exec", tool: "continue_substream", input: { reason: "one more cycle" } },
        { kind: "event", event: { kind: "final", text: "cycle one, still going" } },
      ],
      [{ kind: "event", event: { kind: "final", text: "cycle two, done for real — no continue this time" } }],
    ],
  });
  /** @type {Record<string, unknown>[]} */
  const turnBegins = [];
  being.client.on("turn.begin", (m) => turnBegins.push(m));
  await being.connect();
  t.after(() => being.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria go" });

  await waitFor(() => turnBegins.length >= 2, 10000);
  // the second turn.begin arrived with NO new roomInput from "mara" — the
  // house alone reactivated it, exactly what autotrigger.mjs's own
  // `reactivate()` action does.
  assert.equal(memoryGet(roomKey, "autotrigger.idle_cycles", undefined), 0, "producedSpeech resets idle_cycles to 0 after cycle one");

  // cycle two calls no continue_substream: an ordinary stop — no third turn.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(turnBegins.length, 2, "no call this cycle = loop ends — a third turn must never begin");
  assert.equal(memoryGet(roomKey, "autotrigger.idle_cycles", undefined), 0);
});

test("autotrigger off: an ordinary turn never gets a second turn.begin on its own", async (t) => {
  const { roomKey, id } = await realRoom("off");
  memorySet(roomKey, "autotrigger.on", false);

  const sockDir = mkdtempSync(join(tmpdir(), "settings-consumers-sock-off-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const being = new MockBeing({
    path: sockPath,
    seatId: "aria-off",
    being: "aria",
    room: id,
    script: [{ kind: "event", event: { kind: "final", text: "just an ordinary reply" } }],
  });
  /** @type {Record<string, unknown>[]} */
  const turnBegins = [];
  being.client.on("turn.begin", (m) => turnBegins.push(m));
  await being.connect();
  t.after(() => being.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria hi" });
  await waitFor(() => turnBegins.length >= 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(turnBegins.length, 1, "autotrigger off must never reactivate");
});

test("idle-cycle ejection: a run of speech-only-less cycles posts a house notice and stops reactivating", async (t) => {
  const { roomKey, id } = await realRoom("ejects");
  memorySet(roomKey, "autotrigger.on", true);
  memorySet(roomKey, "autotrigger.max_speech_only", 2);

  const sockDir = mkdtempSync(join(tmpdir(), "settings-consumers-sock-eject-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const idleStep = [{ kind: "tool.exec", tool: "continue_substream", input: {} }, { kind: "event", event: { kind: "final", text: "" } }];
  const being = new MockBeing({
    path: sockPath,
    seatId: "aria-eject",
    being: "aria",
    room: id,
    script: [idleStep, idleStep, idleStep, idleStep],
  });
  /** @type {Record<string, unknown>[]} */
  const turnBegins = [];
  being.client.on("turn.begin", (m) => turnBegins.push(m));
  await being.connect();
  t.after(() => being.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria go" });

  // cap 2: cycle1 idle=1 (reactivate), cycle2 idle=2>=cap (ejected, no 3rd turn).
  await waitFor(() => turnBegins.length >= 2, 10000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(turnBegins.length, 2, "the safety net must stop reactivation once the idle cap is reached");
  assert.equal(memoryGet(roomKey, "autotrigger.idle_cycles", undefined), 2);
});

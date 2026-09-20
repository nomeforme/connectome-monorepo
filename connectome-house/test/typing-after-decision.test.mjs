// @ts-check
/* connectome-house/test/typing-after-decision.test.mjs — harness-port 34
 * (docs/harness-port/34-typing-after-decision.md): typing switches on
 * ONLY once the room's own recorded decision is known, never off this
 * seat's own speculative guess (every present seat computes its own
 * activation independently — dispatch.mjs's `random_reply` is a real
 * per-seat `Math.random()`, uncorrelated across seats). Fixes the race
 * docs/harness-port/31-silent-turn.md named at the cause, in
 * `room-tails.mjs`'s own `applyInputAction`: typing/lifecycle now start
 * there, gated on `roomInput()`'s own answer — `a.targets` on a win (the
 * room never re-decides once targets ride the call), `r.to` (serve-
 * rooms.mjs's own recorded-frame lookup) on a `{duplicate:true}` answer.
 *
 * Half 1: fast, mock-`turns` unit tests directly against `applyInputAction`
 * (room-multi-seat.test.mjs's own pattern) — tests (a)/(b)/(c) below.
 * Half 2: a real `createSeat` + the REAL `roomInput` (serve-rooms.mjs,
 * unmocked), proving a plain mention still types promptly end to end —
 * test (d). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "typing-after-decision-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "typing-after-decision-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { applyInputAction } = await import("../src/mcpl/room-tails.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

/** deps shape applyInputAction needs, everything but `roomInput`/`turns`
 * held constant across the mock tests below. */
function baseDeps(turns) {
  return {
    cfg: { platform: "synthetic", being: "flora" },
    relay: { markPlatformOrigin: () => {} },
    turns,
    pendingReply: { push: () => {} },
    stats: { inputs: 0 },
    streaks: new Map(),
    linkGate: { notifyUnlinkedRoom: () => {} },
    addParticipant: () => {},
  };
}

const baseAction = {
  by: "mara",
  by_kind: "human",
  home: "testbox",
  text: "@flora?",
  observe: false,
  stream: "s1",
  external: { platform: "synthetic", message_id: "m1" },
};
const baseCtx = { msg: { messageId: "m1" }, runDir: "/unused", attachments: [], roomId: "unused" };

test("(a) applyInputAction: a losing seat's own random-reply 'yes' never turns typing on when the room's recorded decision named nobody", async () => {
  const activated = [];
  const stopped = [];
  const turns = {
    activate: (stream, being) => activated.push({ stream, being }),
    end: () => {},
    stopTyping: (stream, reason) => stopped.push({ stream, reason }),
  };
  // the room's own recorded (winner's) decision, read back via `to`: nobody.
  const mockRoomInput = async () => ({ ok: true, duplicate: true, to: [] });
  await applyInputAction({ ...baseDeps(turns), roomInput: mockRoomInput }, { ...baseAction, targets: ["flora"] }, baseCtx);
  assert.deepEqual(activated, [], "never typed — the recorded decision named nobody, even though this seat's own guess said yes");
  assert.deepEqual(stopped, [{ stream: "s1", reason: "duplicate" }]);
});

test("(b) applyInputAction: a losing seat DOES turn typing on for its own being when the room's recorded (winner's) decision names it", async () => {
  const activated = [];
  const turns = { activate: (stream, being) => activated.push({ stream, being }), end: () => {}, stopTyping: () => {} };
  // THIS seat's own guess said no (targets: [], observe: true) — but the
  // room's recorded (winner's) decision, read back via `to`, names flora.
  const mockRoomInput = async () => ({ ok: true, duplicate: true, to: ["flora"] });
  await applyInputAction(
    { ...baseDeps(turns), roomInput: mockRoomInput },
    { ...baseAction, targets: [], observe: true },
    baseCtx,
  );
  assert.deepEqual(
    activated,
    [{ stream: "s1", being: "flora" }],
    "typing started for flora — the room's own recorded decision named it, even though this seat's own guess didn't",
  );
});

test("(c) applyInputAction: the winner path is unchanged — typing starts for this seat's own being exactly when its own (recorded) targets name it", async () => {
  const activated = [];
  const turns = { activate: (stream, being) => activated.push({ stream, being }), end: () => {}, stopTyping: () => {} };
  const mockRoomInput = async () => ({ ok: true, started: ["flora"], unseated: [] });
  await applyInputAction({ ...baseDeps(turns), roomInput: mockRoomInput }, { ...baseAction, targets: ["flora"] }, baseCtx);
  assert.deepEqual(activated, [{ stream: "s1", being: "flora" }]);
});

test("(c) applyInputAction: the winner path — no activation, no typing", async () => {
  const activated = [];
  const turns = { activate: (stream, being) => activated.push({ stream, being }), end: () => {}, stopTyping: () => {} };
  const mockRoomInput = async () => ({ ok: true, started: [], unseated: [] });
  await applyInputAction(
    { ...baseDeps(turns), roomInput: mockRoomInput },
    { ...baseAction, targets: [], observe: true },
    baseCtx,
  );
  assert.deepEqual(activated, [], "flora was never a recorded target — never typed");
});

/** an already-NORMALIZED IncomingMessage (mcpl/normalize.mjs's own output
 * shape) — silent-turn-repro.test.mjs's own `msg()`. */
function msg(id, { channelId, author = "alice", text }) {
  return {
    envelope: "incoming",
    eventId: id,
    messageId: id,
    channelId,
    threadId: null,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    text,
    images: [],
    tags: [],
    metadata: {},
    mentions: [],
    replyTo: null,
    replyToAuthorId: null,
    rawContent: null,
    isDM: false,
    isBot: false,
  };
}

test("(d) createSeat, real roomInput: a plain mention still types promptly — typing now fires from inside applyInputAction, not before roomInput() even runs, but the round trip stays fast", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "flora-mention");
  const stream = "discord:g1:typing-after-decision-mention";
  const { id: roomId, error } = await openRoom({
    platform: "discord",
    stream,
    title: "typing-after-decision mention fixture",
    beings: ["flora-mention"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);

  // a REAL being's-turn seat, attached BEFORE the message lands — without
  // one, roomInput reports this being `unseated` (room-multi-seat.test.mjs's
  // own regression) and applyInputAction correctly never types for a being
  // with no seat to answer on at all; this test is about PROMPTNESS once a
  // real turn is actually possible, not that separate (already-covered) gate.
  const sockDir = mkdtempSync(join(tmpdir(), "typing-after-decision-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });
  const being = new MockBeing({
    path: sockPath,
    seatId: "flora-mention-typing-after-decision",
    being: "flora-mention",
    room: roomId,
    script: [{ kind: "event", event: { kind: "final", text: "flora-mention answers" } }],
  });
  await being.connect();
  await waitFor(() => (open.get(roomId)?.seat ? true : null));

  const logLines = [];
  const typingCalls = [];
  let capturedOnIncoming = null;
  const seat = createSeat({
    server: {
      name: "flora-mention-seat",
      platform: "discord",
      being: "flora-mention",
      rooms: [{ stream, title: "t", beings: ["flora-mention"], public: true }],
    },
    log: (line) => logLines.push(line),
    hostOpts: {
      createHost: (opts) => {
        capturedOnIncoming = opts.onIncoming;
        return {
          state: { open: new Set(), self: {} },
          async start() {},
          stop() {},
          restart() {},
          async openChannel() {},
          typing(s, on) {
            typingCalls.push({ stream: s, on });
          },
          lifecycle() {},
          snapshot() {
            return {};
          },
        };
      },
    },
    // no `roomInput` override — the real serve-rooms.mjs one.
  });
  await seat.start();
  const t0 = Date.now();
  await capturedOnIncoming(msg("mention-1", { channelId: stream, text: "alice: @flora-mention are you there?" }));
  await waitFor(() => (typingCalls.some((c) => c.on === true) ? true : null));
  assert.ok(Date.now() - t0 < 2000, "typing turned on promptly for a plain mention");
  assert.ok(logLines.some((l) => l.includes("typing on") && l.includes("@flora-mention")));

  seat.stop();
  await being.close();
  await seatServer.close();
});

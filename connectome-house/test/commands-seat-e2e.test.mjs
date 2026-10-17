// @ts-check
/* connectome-house/test/commands-seat-e2e.test.mjs — harness-port R2-X,
 * 2026-09-17 (mission task 1): the seat-side half of the command lane,
 * end to end through a REAL platform seat (mcpl/seat.mjs's createSeat,
 * driven by the mock MCPL server, test/lib/mock-mcpl-server.mjs) and a
 * REAL room (openRoom/roomInput, never stubbed) — closing the gap
 * test/commands-wired.test.mjs's own header names ("nothing yet calls
 * handleCommand's own reply through a live seat's speak path, nor
 * applies its own intent automatically... requires touching mcpl/
 * seat.mjs"): room-tails.mjs's own `applyCommandAction` (this task's new
 * export), wired into seat.mjs's `apply()`.
 *
 * Three scenarios, three isolated rooms/seats (never sharing state):
 * - !help: the reply is sent through the seat's own speak path AS THE
 *   HOUSE (the mock records a reply_message call quoting the command's
 *   own messageId), and the command line itself lands in frames.jsonl
 *   observe-only (no `to`, never a room turn).
 * - !rr 5: persists (commands/store.mjs), and the exact composition
 *   seat.mjs's routeDeps() wires — roomPostureFor overlaid by
 *   applyCommandDispatchSettings — reads 1-in-5 afterward (a live seat
 *   threads no `rng`, so a genuinely random NEXT roll can't be forced
 *   deterministically end-to-end here — the same documented limitation
 *   test/dispatch-discord-matrix.test.mjs's own header names for O6/O7).
 * - !stop: a being's-turn seat (createHouseSeatServer + a raw
 *   SeatClient that never answers turn.begin, seat-abort.test.mjs's own
 *   pattern) is attached BEFORE the platform seat starts, so an
 *   addressed message opens a genuinely open turn; !stop then reaches it
 *   live through the command lane — the being's own socket receives
 *   `interrupt`, and frames.jsonl records the abort. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "commands-seat-e2e-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "commands-seat-e2e-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "aria"), { recursive: true });

const BEING = "aria";
// discord-shaped, not "mock" — commands/registry.mjs's own platform sets
// (DSW/DS/S_ONLY) never include "mock" (commands-wired.test.mjs's own
// header, verbatim); the MOCK MCPL SERVER (a fake child process) is
// independent of `cfg.platform`, which every command's own availability
// check reads — dispatch-discord-matrix.test.mjs's own established
// pairing ("discord" + the mock child) is reused here for that reason.
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "discord" });

const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");
// harness-port P-A (parity round, 2026-09-17): every hardcoded reply
// string below now goes through fork-replies.mjs, matching commands.
// test.mjs's own convention — see that file's header and registry.mjs's.
const fork = await import("../src/commands/fork-replies.mjs");

/** a channels/incoming message, discord-shaped (mirrors dispatch-discord-
 * matrix.test.mjs's own `msg()`). @param {string} id */
function msg(id, { channelId, author = "alice", text }) {
  return {
    channelId,
    messageId: id,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { mentions: [], rawContent: null, replyTo: null, replyToAuthorId: null, isBot: false },
  };
}

function rowsOf(recordPath) {
  try {
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** @param {string} stream @param {{after_ms: number, text: string, id: string}[]} lines */
function startFixtureSeat(stream, lines) {
  const fixture = join(process.env.HOUSE_PRIVATE_DIR, `${lines[0].id}.fixture.json`);
  const record = join(process.env.HOUSE_PRIVATE_DIR, `${lines[0].id}.record.jsonl`);
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: lines.map((l) => ({ after_ms: l.after_ms, incoming: msg(l.id, { channelId: stream, text: l.text }) })),
    }),
  );
  const seat = createSeat({
    server: {
      name: `cmd-${lines[0].id}`,
      platform: "discord",
      command: "node",
      args: [MOCK, fixture, record],
      env: [],
      being: BEING,
      rooms: [{ stream, title: "cmd e2e", beings: [BEING], public: true }],
      mock: true,
    },
    log: () => {},
  });
  return { seat, record };
}

const seatsToStop = [];
after(async () => {
  for (const s of seatsToStop) s.stop();
});

test("!help: the reply goes out through the seat's own speak path as the house; the line itself is recorded observe-only", async () => {
  const stream = "discord:g1:help";
  const { seat, record } = startFixtureSeat(stream, [{ after_ms: 30, id: "help-1", text: "!help" }]);
  seatsToStop.push(seat);
  await seat.start();

  // harness-port P-A: discord's own !help is now the fork's exact static
  // text (fork-replies.mjs's HELP_TEXT_DISCORD, 2792 chars — over
  // discord-mcpl's own 1900-char split cap, speak.mjs's `splitForDiscord
  // Fork`), so it goes out as more than one chunk. Also: speak.mjs's own
  // `useReply` (a concurrent, unrelated commit landed on this same day)
  // now reads `adapter.replyThreading`, false for discord (O16: "replies
  // are plain sends: no quote, no ping") — every chunk uses `send_message`
  // now, never `reply_message`, so this test no longer asserts a quoted
  // reply (that was never the fork's own behaviour to begin with).
  // splitForDiscordFork prefers a newline/space boundary — trim-aware
  // rejoin recovers all non-whitespace content (its own test's own
  // wording, outbound.mjs). Wait for EVERY chunk, not the first: under
  // load the second chunk landed after a first-call wait and the rejoin
  // came up short (2026-10-17, a concurrent run on Node 24).
  const squash = (s) => s.replace(/\s+/g, "");
  const want = squash(fork.HELP_TEXT_DISCORD);
  const sends = () =>
    rowsOf(record).filter(
      (r) => r.kind === "tools/call" && (r.name === "send_message" || r.name === "reply_message"),
    );
  const rejoinedNow = () => squash(sends().map((c) => c.arguments.content).join(""));
  await waitFor(() => (rejoinedNow().length >= want.length ? true : null));
  assert.ok(sends().length >= 1, "the reply went out (first chunk may be a reply_message — the keeper's UX)");
  assert.equal(rejoinedNow(), want);

  const roomId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);
  const frames = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
  const recorded = frames.find((f) => f.type === "message" && f.text === "!help");
  assert.ok(recorded, "the command line itself is recorded in the room");
  assert.equal(recorded.to, undefined, "observe-only — never an activation");
});

test("!rr 5: persists, and the exact covenant composition seat.mjs's routeDeps wires reads 1-in-5 afterward", async () => {
  const stream = "discord:g1:rr";
  const { seat, record } = startFixtureSeat(stream, [{ after_ms: 30, id: "rr-1", text: "!rr 5" }]);
  seatsToStop.push(seat);
  await seat.start();

  await waitFor(() =>
    rowsOf(record).some(
      (r) => r.kind === "tools/call" && r.arguments?.content === fork.rr.set(5),
    )
      ? true
      : null,
  );

  // seat.mjs's own routeKeyOf: `${cfg.platform}:${roomSlug(stream)}` — the
  // exact room key routeIncoming's covenants() call is made with.
  const { roomPostureFor } = await import("../src/resident-covenant.mjs");
  const { applyCommandDispatchSettings } = await import("../src/commands/store.mjs");
  const { roomSlug } = await import("../src/serve-room-open.mjs");
  const base = roomPostureFor(BEING, `discord:${roomSlug(stream)}`);
  const covenant = { ...base, dispatch: applyCommandDispatchSettings(base.dispatch) };
  assert.equal(covenant.dispatch.random_reply, 5, "the next dispatch decision reads 1-in-5");
});

test("!stop during a mock being's open turn: the seat's interrupt reaches the being, and the record shows the abort", async (t) => {
  const stream = "discord:g1:stop";
  const { id: roomId } = await openRoom({
    platform: "discord",
    stream,
    title: "cmd e2e — stop",
    beings: [BEING],
  });
  const runDir = join(process.env.HOUSE_RUNS_DIR, roomId);

  const sockDir = mkdtempSync(join(tmpdir(), "commands-seat-e2e-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  // a raw SeatClient, never answering turn.begin — the turn stays open
  // until !stop acts on it (seat-abort.test.mjs's own pattern).
  const client = new SeatClient({ path: sockPath, seatId: "aria-stop", being: BEING, room: roomId });
  const seen = [];
  client.on("*", (m) => seen.push(m));
  await client.connect();
  t.after(() => client.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(roomId)?.seat ? true : null));

  const { seat, record } = startFixtureSeat(stream, [
    { after_ms: 30, id: "stop-activate", text: "@aria hi" },
    { after_ms: 500, id: "stop-1", text: "!stop" },
  ]);
  seatsToStop.push(seat);
  await seat.start();

  await waitFor(() => (open.get(roomId)?.turn ? true : null));
  // harness-port P-A: !stop's own SYNCHRONOUS reply is "Stopping aria..."
  // (fork-replies.mjs's own header — this is the correction a prior round
  // needed: "[Cycle stopped]" is NOT the command's own reply, it is a
  // separate, later, conditional notice posted once the turn actually
  // aborts, asserted below via the record instead of via this mock
  // platform seat's reply_message call).
  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.arguments?.content === fork.stop.ack(BEING))
      ? true
      : null,
  );

  await waitFor(() => (open.get(roomId).turn === null ? true : null));
  assert.equal(open.get(roomId).status, "open", "the room stays open — only the turn's own outcome is aborted");

  await waitFor(() => (seen.some((m) => m.type === "interrupt") ? true : null));
  assert.ok(seen.some((m) => m.type === "interrupt" && m.by === "house"), "the being's own socket received the interrupt");

  const frames = framesOf(runDir);
  const aborted = frames.find((f) => f.type === "aborted");
  assert.ok(aborted, "the record shows the abort");
  assert.equal(aborted.reason, "interrupted (!stop)");

  // room-turn.mjs's applyInterrupt also posts the being's own "[Cycle
  // stopped]" notice (O30's target design, fork-replies.mjs's
  // `stop.cycleStoppedNotice`) as a speech frame — matching the fork's
  // real condition (a genuinely open turn) exactly, just posted by the
  // house rather than by the being's own runtime.
  const stoppedNotice = frames.find((f) => f.type === "speech" && f.inline === fork.stop.cycleStoppedNotice);
  assert.ok(stoppedNotice, "the record carries the being's own '[Cycle stopped]' notice");
  assert.equal(stoppedNotice.by, BEING);
});

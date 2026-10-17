// @ts-check
/* connectome-house/test/web-seat-e2e.test.mjs — a web-platform seat end
 * to end: the house's real createSeat spawning the REAL mcpl-web child
 * (../../mcpl-web/src/index.mjs), which connects to mcpl-web's own fake
 * board (../../mcpl-web/test/lib/fake-board.mjs, reused rather than
 * re-implemented); a raw SeatClient stands in for the being and answers
 * every turn with one final speech (test/lib/stub-walker.mjs's pattern,
 * in-process). Proves: the seat christens the being's board principal
 * from mcpl-web's self announcement; a board post mentioning that
 * principal wakes the being, and its answer lands on the board as a
 * plain post (send_message); a reply to the being's own post wakes it
 * again, and that answer is threaded under the reply (reply_message →
 * the board's `reply_to`). Waits are on conditions only. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";
import { createFakeBoard, PRINCIPALS } from "../../mcpl-web/test/lib/fake-board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCPL_WEB_INDEX = join(HERE, "..", "..", "mcpl-web", "src", "index.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "web-seat-e2e-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "web-seat-e2e-salt-0123456789";
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });

const BEING = "zz-web-being";
const PRINCIPAL = { id: `being:${BEING}`, kind: "being", display: "Zed" };
const TOKEN = "tok-zz-web-being-fixture";
const STREAM = "web:commons:general";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "web" });

const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");
const { identityMapReverse } = await import("../src/identity-map.mjs");

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

test("a web seat: a mention of the being's principal wakes it and the answer posts; a reply to it is answered as a threaded reply", async () => {
  const board = await createFakeBoard({ tokens: { [TOKEN]: PRINCIPAL } });
  cleanups.push(() => board.close());

  const { id: roomId } = await openRoom({ platform: "web", stream: STREAM, title: "commons #General", beings: [BEING] });

  // the being: answers every turn with one final speech naming what woke it
  const sockDir = mkdtempSync(join(tmpdir(), "web-seat-e2e-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });
  cleanups.push(async () => seatServer.close());
  const being = new SeatClient({ path: sockPath, seatId: "zz-web-being-stub", being: BEING, room: roomId });
  let turns = 0;
  being.on("turn.begin", (tb) => {
    turns += 1;
    being.send({ type: "turn.event", room: tb.room, turnId: tb.turnId, event: { kind: "final", text: `answer ${turns}` } });
    being.send({ type: "turn.done", room: tb.room, turnId: tb.turnId });
  });
  await being.connect();
  cleanups.push(() => being.close());
  await waitFor(() => (open.get(roomId)?.seat ? true : null));

  process.env.WEB_BOARD_URL = board.url;
  process.env.WEB_BOARD_TOKEN = TOKEN;
  process.env.WEB_POLICY_GRACE_MS = "5000";
  const seat = createSeat({
    server: {
      name: "web-zz",
      platform: "web",
      command: process.execPath,
      args: [MCPL_WEB_INDEX],
      env: ["WEB_BOARD_URL", "WEB_BOARD_TOKEN", "WEB_POLICY_GRACE_MS"],
      being: BEING,
      rooms: [{ stream: STREAM, title: null, beings: [BEING], public: true }],
    },
    log: () => {},
  });
  cleanups.push(() => seat.stop());
  await seat.start();

  // the seat christens the being's board principal from mcpl-web's self
  await waitFor(() => (identityMapReverse(BEING, "web")?.id === PRINCIPAL.id ? true : null));
  await waitFor(() => (board.subscribedCount() === 1 && seat.host.state.open.has(STREAM) ? true : null));

  const ask = board.emitPost({ author: PRINCIPALS.bob, text: "@Zed what's growing in the garden?" });
  assert.deepEqual(ask.mentions, [PRINCIPAL.id], "the board resolved the @display to the being's principal");
  const first = await waitFor(() => board.state.posts.find((p) => p.author.id === PRINCIPAL.id && p.text === "answer 1"));
  assert.equal(first.reply_to, null, "a mention is answered plain (send_message)");
  assert.equal(first.room, STREAM);

  const frames = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
  const asked = frames.find((f) => f.type === "message" && typeof f.text === "string" && f.text.includes("what's growing"));
  assert.ok(asked, "the board post is in the room's record");
  assert.ok(asked.text.startsWith(`@${BEING} `), "the being's principal is rewritten to its handle");
  assert.deepEqual(asked.to, [BEING], "the mention activated the being");

  const reply = board.emitPost({ author: PRINCIPALS.bob, text: "lovely, more please", reply_to: first.id });
  const second = await waitFor(() => board.state.posts.find((p) => p.author.id === PRINCIPAL.id && p.text === "answer 2"));
  assert.equal(second.reply_to, reply.id, "a reply to the being is answered as a threaded reply (reply_message)");
  assert.equal(board.state.posts.filter((p) => p.author.id === PRINCIPAL.id).length, 2, "nothing posted twice");
});

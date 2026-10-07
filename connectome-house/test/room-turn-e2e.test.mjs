// @ts-check
/* connectome-house/test/room-turn-e2e.test.mjs — the round's own golden
 * test (docs/harness-port/03-house-design.md §2.4 stage P2, 06-rounds.md
 * R2-A): one synthetic room, one being (`aria`) seated over a REAL unix
 * socket (`@connectome/seat-protocol`'s `SocketSeatServer`, house side;
 * `@connectome/seat-client`'s `MockBeing`, being side), a scripted
 * multi-turn conversation — two humans (`mara`, `theo`), three of the
 * being's own turns, one `tool.exec` round-trip (refused: no platform
 * executor is registered for a synthetic room), one observe-only line
 * (a message that never mentions/replies/DMs the being, so
 * `dispatch.mjs`'s `decideActivation` never starts a turn for it) — then
 * a rest. Asserts: the resulting frames.jsonl matches a golden fixture
 * modulo timestamps and ids (deepEqual after normalizing both sides, in
 * place of a literal byte-compare — see this file's own `normalize()` for
 * why: `room.mounted.substrate` depends on whether this box's chronicle
 * native binding loaded, `room.mounted.run` and every `reach`/
 * `reach.result` `callId` are randomUUIDs, none of it behavior this test
 * should pin); every frame validates against frame-schema.mjs's closed
 * `Frame` union; and `aria`'s own life gained exactly one period
 * (life-entries.mjs's append marker) once the room rests.
 *
 * In-process, not a spawned `serve.mjs` child (unlike test/lib/
 * serve-harness.mjs's HTTP tests): `openRoom`/`roomInput`/`restRoom` are
 * called directly, same as every other house unit test — the REAL thing
 * under test is the socket transport between `seat/socket-seat.mjs` and
 * `@connectome/seat-client`, which is exercised end to end regardless of
 * whether the room side is a separate process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { MockBeing } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-turn-e2e-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
// `mara`/`theo` are plain humans (no testament) — identity-map.mjs's
// `identityKnown` accepts a handle with an existing private root even
// with no testament at all; `aria` gets one below via writeTestament.
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "theo"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom, roomInput, restRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { Frame } = await import("../src/frame-schema.mjs");
const { readAppendMarker } = await import("../src/life-entries.mjs");
const { drainLifeJobs } = await import("../src/life-jobs.mjs");

const ajv = new Ajv({ strict: false });
const validateFrame = ajv.compile(Frame);

/** strip everything the golden fixture can't pin (timestamps, minted
 * ids, the chronicle-vs-jsonl-fallback substrate) — see this file's
 * header for why each one varies. */
function normalize(frame) {
  const { t, ...rest } = frame;
  if (rest.type === "room.mounted") return { ...rest, run: "<normalized>", substrate: "<normalized>" };
  if (rest.callId) return { ...rest, callId: "<normalized>" };
  return rest;
}

test("room worker loop: a scripted multi-turn conversation over a real unix socket matches the golden record", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "room-turn-e2e-1",
    title: "a synthetic room, for room-turn-e2e.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), "room-turn-e2e-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  // turn 1: tokens then final, no tools — turn 2: one tool.exec round-trip
  // (refused: this synthetic room registers no platform executor) then a
  // final — turn 3: a final only. One array per successive turn.begin.
  const being = new MockBeing({
    path: sockPath,
    seatId: "aria-seat-1",
    being: "aria",
    room: id,
    script: [
      [
        { kind: "event", event: { kind: "tokens", text: "Hi " } },
        { kind: "event", event: { kind: "final", text: "Hi there!" } },
      ],
      [
        { kind: "tool.exec", tool: "lookup", input: { q: "archive" } },
        { kind: "event", event: { kind: "final", text: "I couldn't look that up, but here's what I know." } },
      ],
      [{ kind: "event", event: { kind: "final", text: "You're welcome!" } }],
    ],
  });
  const observedLines = [];
  being.client.on("line", (msg) => observedLines.push(msg));
  const turnBegins = [];
  being.client.on("turn.begin", (msg) => turnBegins.push(msg));
  await being.connect();
  // t.after() hooks run in REGISTRATION order (FIFO), not LIFO — the
  // being's own socket must close BEFORE the server does, or
  // net.Server#close()'s callback waits forever for a still-live
  // connection only a LATER hook would end (found live, 2026-09-17;
  // matches connectome-seat-client/test/socket-round-trip.test.mjs's own
  // documented lesson: "close the being's socket before the server").
  t.after(() => being.close());
  t.after(async () => {
    await server.close();
  });

  await waitFor(() => (open.get(id)?.seat ? true : null));
  assert.equal(open.get(id).seat.being, "aria", "the handshake's own being name reached attachSeat");

  // turn 1: an addressed mention -> a turn, not a line.
  await roomInput({ id, by: "mara", text: "@aria hi there" });
  await waitFor(() => (open.get(id).turn === null ? true : null));

  // an unaddressed message -> observe-only: a `line`, never a turn.
  await roomInput({ id, by: "mara", text: "just chatting to myself" });
  await waitFor(() => observedLines.length >= 1);
  assert.equal(observedLines[0].by, "mara");
  assert.equal(observedLines[0].observe, true);
  assert.equal(open.get(id).turn, null, "an unaddressed message never starts a turn");

  // turn 2: a mention with a tool.exec round-trip (refused: not offered).
  await roomInput({ id, by: "theo", text: "@aria can you look something up?" });
  await waitFor(() => (open.get(id).turn === null ? true : null));

  // turn 3: a plain mention, no tools.
  await roomInput({ id, by: "theo", text: "@aria thanks!" });
  await waitFor(() => (open.get(id).turn === null ? true : null));

  await restRoom(open.get(id));
  await drainLifeJobs(); // the rest queues its life append to a child process (life-jobs.mjs)

  const frames = framesOf(runDir);
  for (const f of frames) {
    assert.ok(validateFrame(f), `frame failed the house's closed schema: ${ajv.errorsText(validateFrame.errors)} — ${JSON.stringify(f)}`);
  }

  const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/room-turn-e2e.golden.json"), "utf8"));
  assert.deepEqual(frames.map(normalize), golden);

  // turn.begin's own rendered context: turn 2 (index 1) should already
  // carry turn 1's OWN final speech under aria's own handle — the reused
  // life-entries.mjs renderer's "own turns as assistant" rule, not a
  // second one invented for this transport.
  const turn2Context = /** @type {any} */ (turnBegins[1]).context;
  const ownTurn = turn2Context.conversation.find(
    (m) => m.participant === "aria" && m.content?.[0]?.text?.includes("Hi there!"),
  );
  assert.ok(ownTurn, "turn 2's rendered conversation should carry turn 1's own speech under aria's own handle");
  const humanTurn = turn2Context.conversation.find(
    (m) => m.participant === "mara" && m.content?.[0]?.text?.includes("hi there"),
  );
  assert.ok(humanTurn, "turn 2's rendered conversation should carry mara's own line under her own handle");

  const marker = readAppendMarker(runDir, "aria");
  assert.ok(marker, "aria's life should have an append marker once the room rested");
  assert.equal(marker.sessions.length, 1, "aria's life gained exactly one period");
});

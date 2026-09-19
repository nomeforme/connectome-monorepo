// @ts-check
/* connectome-house/test/seat-bus.test.mjs — harness-port W7-b, 2026-09-19:
 * "the slowdown" removed. Two halves:
 *   - createFrameDelivery's own offset-cursor idempotence, unit-tested
 *     directly against frames-io.mjs's real bus (no seat, no mock server —
 *     fast and exact): a bus-delivered frame is never re-delivered by its
 *     own startup sweep run right after, and a frame appended before ANY
 *     delivery existed is still caught by that startup sweep.
 *   - the real, measured claim: a speech frame's send_message reaches a
 *     REAL mock MCPL server (test/lib/mock-mcpl-server.mjs) within 50ms
 *     of the append — through a real `createSeat`, matching test/
 *     mcpl-sweep.test.mjs's own setup pattern.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendHouseFrame, tailFrames } from "../src/frames-io.mjs";
import { createFrameDelivery } from "../src/mcpl/seat-bus.mjs";
import { writeClass, writeFrames, writeTestament } from "./lib/fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");
const noop = () => {};

// ---------------------------------------------------------------------
// half 1: createFrameDelivery's own idempotence — no seat, no child.
// ---------------------------------------------------------------------
const UNIT_RUNS = mkdtempSync(join(tmpdir(), "house-seat-bus-unit-"));

/** a room's own bare `tails` entry — an empty frames.jsonl to append to. */
function makeTail(id) {
  const runDir = join(UNIT_RUNS, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "frames.jsonl"), "");
  return { runDir, t: { runDir, stream: "mock:unit", offset: 0, forkName: null } };
}

test("createFrameDelivery: a bus-delivered frame is never re-delivered by its own startup sweep run right after", () => {
  const id = "room-a";
  const { runDir, t } = makeTail(id);
  const tails = new Map([[id, t]]);
  const delivered = [];
  const fd = createFrameDelivery({
    tails,
    tailFrames,
    onFrame: (_roomId, _stream, _rd, f) => delivered.push(f),
    checkSelf: noop,
    redeliverCheck: noop,
  });
  appendHouseFrame(join(runDir, "frames.jsonl"), { type: "speech", by: "sam", inline: "hi" });
  assert.equal(delivered.length, 1, "the bus delivered it at once");
  fd.startupSweep(); // a sweep tick, right after the bus already drained it
  assert.equal(delivered.length, 1, "the sweep found nothing new — never delivered twice");
  fd.stop();
});

test("a frame appended before this seat's own frame delivery existed is still caught by the startup sweep", () => {
  const id = "room-b";
  const { runDir, t } = makeTail(id);
  const tails = new Map([[id, t]]);
  // the bus fires into the void here — nothing is listening yet
  appendHouseFrame(join(runDir, "frames.jsonl"), { type: "speech", by: "sam", inline: "missed" });
  const delivered = [];
  const fd = createFrameDelivery({
    tails,
    tailFrames,
    onFrame: (_roomId, _stream, _rd, f) => delivered.push(f),
    checkSelf: noop,
    redeliverCheck: noop,
  });
  assert.equal(delivered.length, 0, "no listener was live to catch the bus event");
  fd.startupSweep();
  assert.equal(delivered.length, 1, "the startup sweep's own offset-cursor tail still finds it");
  fd.stop();
});

after(() => rmSync(UNIT_RUNS, { recursive: true, force: true }));

// ---------------------------------------------------------------------
// half 2: real end-to-end — a real createSeat, a real mock MCPL server
// child process, measuring wall-clock latency (mcpl-sweep.test.mjs's own
// setup pattern; discord-delivery.test.mjs's own appendFrames-then-
// waitFor pattern, here appendHouseFrame instead, and timed).
// ---------------------------------------------------------------------
const RUNS = mkdtempSync(join(tmpdir(), "house-seat-bus-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-seat-bus-private-"));
const ADDRESS = mkdtempSync(join(tmpdir(), "house-seat-bus-address-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_COVENANTS_DIR = ADDRESS;
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "seat-bus-test-salt-0123456789012";

const BEING = "zz-seat-bus";
const STREAM = "mock:g1:c1";
const ROOM_ID = "room-seat-bus-fixture";
writeTestament(ADDRESS, BEING, { frontmatter: ["posture: present"] });

const runDir = join(RUNS, ROOM_ID);
writeClass(runDir, { room: { platform: "mock", stream: STREAM }, beings: [BEING] });
writeFrames(runDir, []);

const FIXTURE = join(PRIVATE, "mock.fixture.json");
const RECORD = join(PRIVATE, "mock.record.jsonl");
writeFileSync(
  FIXTURE,
  JSON.stringify({
    channels: [{ id: STREAM, type: "mock", label: "#general (Mock)", direction: "bidirectional" }],
    script: [],
  }),
);

const { createSeat } = await import("../src/mcpl/seat.mjs");
const seat = createSeat({
  server: {
    name: "seat-bus-pilot",
    platform: "mock",
    command: "node",
    args: [MOCK, FIXTURE, RECORD],
    env: [],
    being: BEING,
    being_id: "bot-seat-bus-0001",
    rooms: [{ stream: STREAM, title: "mock general", beings: [BEING], public: true }],
    mock: true,
  },
  log: () => {},
  openRoom: async () => ({ id: ROOM_ID, state: "open" }),
  roomInput: async () => ({ ok: true }),
});

after(async () => {
  seat.stop();
  for (const d of [RUNS, PRIVATE, ADDRESS]) rmSync(d, { recursive: true, force: true });
});

const recordRows = () =>
  existsSync(RECORD)
    ? readFileSync(RECORD, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

test("the bus, not the poll: a speech frame's send_message reaches the mock server within 50ms of the append", async (t) => {
  await seat.start();
  // let channels/register settle first — mcpl-sweep.test.mjs's own convention
  await new Promise((r) => setTimeout(r, 300));
  const before = recordRows().length;
  const t0 = Date.now();
  appendHouseFrame(join(runDir, "frames.jsonl"), { type: "speech", by: BEING, inline: "hi, instantly" });
  let row = null;
  for (let i = 0; i < 300 && !row; i++) {
    row = recordRows()
      .slice(before)
      .find((r) => r.kind === "tools/call" && r.name === "send_message");
    if (!row) await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(row, "send_message was never recorded by the mock server");
  const elapsed = row.t - t0;
  t.diagnostic(`send_message recorded ${elapsed}ms after the append (bus path, no 250ms poll wait)`);
  assert.ok(elapsed < 50, `took ${elapsed}ms — expected well under the old 250ms poll`);
});

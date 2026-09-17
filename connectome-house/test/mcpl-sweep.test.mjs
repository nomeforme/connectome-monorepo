// @ts-check
// harness/test/mcpl-sweep.test.mjs — the missed-message sweep, on seat
// start, off the channel history a REAL mock MCPL server's own
// channels/open response returns. Already-recorded ids are skipped;
// a new one is recorded, never woken; one house line names the count.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeClass, writeFrames, writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");
const RUNS = mkdtempSync(join(tmpdir(), "house-mcpl-sweep-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-mcpl-sweep-private-"));
const ADDRESS = mkdtempSync(join(tmpdir(), "house-mcpl-sweep-address-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_COVENANTS_DIR = ADDRESS;
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "mcpl-sweep-salt-0123456789";

const PRESENT = "zz-sweep-present";
const STREAM = "mock:g1:c1";
const ROOM_ID = "room-mock-sweep-fixture";
writeTestament(ADDRESS, PRESENT, { frontmatter: ["posture: present"] });

const { identityFor } = await import("../src/identity-map.mjs");
const alice = identityFor({ platform: "mock", id: "user-alice", display: "alice" }).handle;

// the room already has a record — this is what makes it sweep-eligible;
// a brand-new channel mints from the next live message instead.
const runDir = join(RUNS, ROOM_ID);
writeClass(runDir, { room: { platform: "mock", stream: STREAM }, beings: [PRESENT] });
writeFrames(runDir, []);
writeFileSync(
  join(runDir, "external.jsonl"),
  `${JSON.stringify({ t: new Date(Date.now() - 60_000).toISOString(), direction: "in", platform: "mock", message_id: "hist-1", author: alice })}\n`,
);

const FIXTURE = join(PRIVATE, "mock.fixture.json");
const RECORD = join(PRIVATE, "mock.record.jsonl");
const hist = (messageId, text, msAgo) => ({
  channelId: STREAM,
  messageId,
  author: { id: "user-alice", name: "alice" },
  timestamp: new Date(Date.now() - msAgo).toISOString(),
  content: [{ type: "text", text: `alice: ${text}` }],
  metadata: { isBot: false },
});
writeFileSync(
  FIXTURE,
  JSON.stringify({
    channels: [{ id: STREAM, type: "mock", label: "#general (Mock)", direction: "bidirectional" }],
    history: {
      [STREAM]: [hist("hist-1", "already recorded, skip me", 60_000), hist("hist-2", "catch this one please", 30_000)],
    },
    script: [],
  }),
);

const { createSeat } = await import("../src/mcpl/seat.mjs");

/** @type {any[]} */
const roomInputCalls = [];
const seat = createSeat({
  server: {
    name: "sweep-pilot",
    platform: "mock",
    command: "node",
    args: [MOCK, FIXTURE, RECORD],
    env: [],
    being: PRESENT,
    being_id: "bot-sweep-0001",
    rooms: [{ stream: STREAM, title: "mock general", beings: [PRESENT], public: true }],
    mock: true,
  },
  log: () => {},
  openRoom: async () => ({ id: ROOM_ID, state: "open" }),
  roomInput: async (args) => {
    roomInputCalls.push(args);
    return { ok: true };
  },
});
await seat.start();

after(async () => {
  seat.stop();
  for (const d of [RUNS, PRIVATE, ADDRESS]) rmSync(d, { recursive: true, force: true });
});

const framesOf = () =>
  readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("channel history caught up on seat start: the already-recorded message is skipped, the missed one lands, one house line names the count", async () => {
  const caught = await waitFor(() => roomInputCalls.find((c) => c.text?.includes("catch this one please")));
  assert.equal(caught.id, ROOM_ID);
  assert.equal(caught.observe, true, "placeholder default: record only, never woken");
  assert.deepEqual(caught.targets, [], "no target ever activates from a missed message alone");
  assert.equal(
    roomInputCalls.some((c) => c.text?.includes("already recorded")),
    false,
    "already in external.jsonl — deduped by message_id, never re-applied",
  );
  const houseLines = await waitFor(() =>
    framesOf().filter((f) => f.type === "message" && f.by === "house" && /caught up/.test(f.text ?? "")),
  );
  assert.equal(houseLines.length, 1, "exactly one house line, however many messages were caught up");
  assert.match(houseLines[0].text, /caught up 1 missed message/);
  // never twice — a second look at the same history is a no-op
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(
    roomInputCalls.filter((c) => c.text?.includes("catch this one please")).length,
    1,
    "swept exactly once",
  );
});

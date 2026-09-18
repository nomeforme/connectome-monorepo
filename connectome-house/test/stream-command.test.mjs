// @ts-check
/* connectome-house/test/stream-command.test.mjs — builder Q2-A, 2026-09-18
 * (harness-port mission: `!stream in|out`, C13). End to end through a
 * REAL platform seat (mcpl/seat.mjs's createSeat, driven by the mock MCPL
 * server, test/lib/mock-mcpl-server.mjs) and a REAL room (openRoom, never
 * stubbed) — commands-seat-e2e.test.mjs's own pattern, one scenario, one
 * isolated room/seat:
 *
 * - `!stream in training`: the reply is fork-replies.mjs's own byte-exact
 *   `fork.stream.in(...)`; the child room lands on disk with the SAME
 *   `forkedFrom` shape connectome-history-import writes (room-fork.test.mjs
 *   covers that shape in full — this file only checks the seat actually
 *   reaches it); `!stream out`'s reply matches too.
 * - an addressed message while "in" the fork is recorded in the CHILD's
 *   own frames.jsonl, never the parent's (mcpl/room-tails.mjs's new
 *   `applyInputAction`, consulting `activeFork`) — this is the real
 *   redirect, exercised through routeIncoming/roomInput, no faking.
 * - a speech frame appended to the CHILD's record (standing in for a
 *   being's own turn output — this file never drives a live being's-turn
 *   seat; see this task's own report for why) is relayed to the PARENT's
 *   own platform channel with the fleet's own relay prefix, byte-exact
 *   (seat.mjs's onFrame + room-fork.mjs's streamRelay).
 * - after `!stream out`, a further addressed message returns to being
 *   recorded in the PARENT.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "stream-command-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "stream-command-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const BEING = "aria";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "discord" });

const { createSeat } = await import("../src/mcpl/seat.mjs");
const { readCls } = await import("../src/room-policy.mjs");
const { activeFork, streamRelay } = await import("../src/room-fork.mjs");
const fork = await import("../src/commands/fork-replies.mjs");

const RUNS = process.env.HOUSE_RUNS_DIR;

/** discord-shaped incoming message (mirrors commands-seat-e2e.test.mjs's own `msg()`). */
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

const stream = "discord:g1:stream-cmd";
const fixture = join(process.env.HOUSE_PRIVATE_DIR, "stream-cmd.fixture.json");
const record = join(process.env.HOUSE_PRIVATE_DIR, "stream-cmd.record.jsonl");
writeFileSync(
  fixture,
  JSON.stringify({
    channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
    history: {},
    script: [
      { after_ms: 30, incoming: msg("s-1", { channelId: stream, text: "!stream in training" }) },
      { after_ms: 300, incoming: msg("s-2", { channelId: stream, text: "@aria hello from the parent" }) },
      { after_ms: 900, incoming: msg("s-3", { channelId: stream, text: "!stream out" }) },
      { after_ms: 1100, incoming: msg("s-4", { channelId: stream, text: "@aria hello again" }) },
    ],
  }),
);

const seat = createSeat({
  server: {
    name: "stream-cmd",
    platform: "discord",
    command: "node",
    args: [MOCK, fixture, record],
    env: [],
    being: BEING,
    rooms: [{ stream, title: "stream cmd e2e", beings: [BEING], public: true }],
    mock: true,
  },
  log: () => {},
});
after(() => seat.stop());

test("!stream in training: byte-exact reply, child forked, input redirected there", async () => {
  await seat.start();

  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.arguments?.content === fork.stream.in("training", BEING))
      ? true
      : null,
  );

  const parentId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);
  const parentFrames = framesOf(join(RUNS, parentId));
  const cmdLine = parentFrames.find((f) => f.type === "message" && f.text === "!stream in training");
  assert.ok(cmdLine, "the command line itself is recorded in the parent");
  assert.equal(cmdLine.to, undefined, "observe-only — never an activation");
  assert.ok(
    parentFrames.some((f) => f.type === "branch.created"),
    "the parent's own record carries the fork",
  );

  const active = await waitFor(() => activeFork(parentId));
  assert.equal(active.name, "training");
  const childId = active.id;
  assert.deepEqual(readCls(join(RUNS, childId)).forkedFrom.run, parentId);

  // the addressed message that follows redirects into the CHILD, never the parent.
  await waitFor(() =>
    framesOf(join(RUNS, childId)).some((f) => f.type === "message" && f.text?.includes("hello from the parent"))
      ? true
      : null,
  );
  assert.ok(
    !framesOf(join(RUNS, parentId)).some((f) => f.type === "message" && f.text?.includes("hello from the parent")),
    "the addressed message while 'in' the fork never lands in the parent's own record",
  );

  // stand in for the being's own turn output in the child (this task's
  // report names why a live socket-seat round trip isn't driven here);
  // seat.mjs's own poll loop picks up any frame appended to a tracked
  // room's frames.jsonl, live turn or not.
  const childFramesPath = join(RUNS, childId, "frames.jsonl");
  const nextSeq = Math.max(...framesOf(join(RUNS, childId)).map((f) => f.seq)) + 1;
  appendFileSync(
    childFramesPath,
    `${JSON.stringify({ seq: nextSeq, t: new Date().toISOString(), type: "speech", by: BEING, inline: "hi from the fork" })}\n`,
  );

  const expected = streamRelay.prefix("discord", "training", BEING) + "hi from the fork";
  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.name === "send_message" && r.arguments?.content === expected)
      ? true
      : null,
  );
  const relayed = rowsOf(record).find(
    (r) => r.kind === "tools/call" && r.name === "send_message" && r.arguments?.content === expected,
  );
  assert.equal(relayed.arguments.channelId, stream, "rendered into the PARENT's own platform channel — the fork has none of its own");
});

test("!stream out: the active pointer clears, and a further addressed message returns to the parent", async () => {
  const parentId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);

  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.arguments?.content === fork.stream.out(BEING)) ? true : null,
  );
  await waitFor(() => (activeFork(parentId) === null ? true : null));

  await waitFor(() =>
    framesOf(join(RUNS, parentId)).some((f) => f.type === "message" && f.text?.includes("hello again")) ? true : null,
  );
});

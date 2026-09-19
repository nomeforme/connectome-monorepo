// @ts-check
/* connectome-house/test/stream-command.test.mjs — builder Q2-A, 2026-09-18
 * (harness-port mission: `!stream in|out`, C13); the being's-turn half
 * rewritten by builder Q3-A, 2026-09-18 (the fork-turn gap) to drive a
 * REAL socket seat + MockBeing (test/settings-consumers.test.mjs's own
 * pattern) instead of hand-appending a stand-in speech frame — this is
 * the proof that socket-seat.mjs's `turnRecFor` fix actually resolves a
 * turn begun while a fork is active to the CHILD record, not the stale
 * parent binding the wire connection handshook onto.
 *
 * End to end through a REAL platform seat (mcpl/seat.mjs's createSeat,
 * driven by the mock MCPL server, test/lib/mock-mcpl-server.mjs), a REAL
 * room (openRoom, never stubbed), and a REAL being's-turn socket seat
 * (createHouseSeatServer + MockBeing, attached to the PARENT room before
 * any fork exists — room-tails.mjs's applyCommandAction only copies
 * `rec.seat` onto a newly-minted child AT FORK TIME, so the being's seat
 * must already be live on the parent before `!stream in` runs):
 *
 * - `!stream in training`: the reply is fork-replies.mjs's own byte-exact
 *   `fork.stream.in(...)`; the child room lands on disk with the SAME
 *   `forkedFrom` shape connectome-history-import writes (room-fork.test.mjs
 *   covers that shape in full — this file only checks the seat actually
 *   reaches it); `!stream out`'s reply matches too.
 * - an addressed message while "in" the fork is recorded in the CHILD's
 *   own frames.jsonl, never the parent's (mcpl/room-tails.mjs's
 *   `applyInputAction`, consulting `activeFork`) — this is the real
 *   redirect, exercised through routeIncoming/roomInput, no faking.
 * - that same addressed message activates a REAL turn on the being's own
 *   socket seat (childRec inherited the parent's live seat at fork time);
 *   MockBeing answers it, and the resulting speech frame lands in the
 *   CHILD's record, never the parent's — proving the fix, not stubbing
 *   around the gap it closes.
 * - that speech is relayed to the PARENT's own platform channel with the
 *   fleet's own relay prefix, byte-exact (seat.mjs's onFrame +
 *   room-fork.mjs's streamRelay).
 * - after `!stream out`, a further addressed message returns to being
 *   recorded in the PARENT.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockBeing } from "@connectome/seat-client";
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
const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
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

// harness-port Q3-A: the room is pre-opened here (never left for the
// platform fixture's first message to mint it) so a real being's-turn
// socket seat can attach BEFORE `!stream in training` forks — the fork
// only copies `rec.seat` onto the child AT FORK TIME (room-tails.mjs's
// applyCommandAction); a seat attached later would never reach it.
const { id: parentId, error: openError } = await openRoom({
  platform: "discord",
  stream,
  title: "stream cmd e2e",
  beings: [BEING],
});
if (openError) throw new Error(`openRoom failed: ${openError}`);

const sockDir = mkdtempSync(join(tmpdir(), "stream-command-sock-"));
const sockPath = join(sockDir, "seat.sock");
const seatServer = createHouseSeatServer({ log: () => {} });
await seatServer.listen({ path: sockPath });

const being = new MockBeing({
  path: sockPath,
  seatId: "aria-stream-cmd",
  being: BEING,
  room: parentId,
  script: [{ kind: "event", event: { kind: "final", text: "hi from the fork" } }],
});

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
// registration order matters (FIFO): the being's own socket must close
// before the server it is attached to (seat-abort.test.mjs's own note).
after(() => seat.stop());
after(() => being.close());
after(async () => seatServer.close());

test("!stream in training: byte-exact reply, child forked, input redirected there, and the being's own turn — a real socket seat — speaks in the child, relayed to the parent's channel", async () => {
  await being.connect();
  await waitFor(() => (open.get(parentId)?.seat ? true : null));
  await seat.start();

  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.arguments?.content === fork.stream.in("training", BEING))
      ? true
      : null,
  );

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

  // that same addressed message activated a REAL turn — begun against the
  // child (room-tails.mjs's applyInputAction, redirected via activeFork),
  // sent over the seat the child inherited at fork time, answered by
  // MockBeing over the wire. Its turn.event lands here, in the CHILD's
  // own frames.jsonl, only because socket-seat.mjs's turnRecFor now
  // resolves a live turn's own room per-message instead of trusting the
  // parent binding fixed at handshake — this task's own fix.
  await waitFor(() =>
    framesOf(join(RUNS, childId)).some((f) => f.type === "speech" && f.by === BEING && f.inline === "hi from the fork")
      ? true
      : null,
  );
  assert.ok(
    !framesOf(join(RUNS, parentId)).some((f) => f.type === "speech" && f.inline === "hi from the fork"),
    "the being's own turn output never lands in the parent's record while the fork is active",
  );

  const expected = streamRelay.prefix("discord", "training", BEING) + "hi from the fork";
  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && (r.name === "send_message" || r.name === "reply_message") && r.arguments?.content === expected)
      ? true
      : null,
  );
  const relayed = rowsOf(record).find(
    (r) => r.kind === "tools/call" && (r.name === "send_message" || r.name === "reply_message") && r.arguments?.content === expected,
  );
  assert.equal(relayed.arguments.channelId, stream, "rendered into the PARENT's own platform channel — the fork has none of its own");
});

test("!stream out: the active pointer clears, and a further addressed message returns to the parent", async () => {
  await waitFor(() =>
    rowsOf(record).some((r) => r.kind === "tools/call" && r.arguments?.content === fork.stream.out(BEING)) ? true : null,
  );
  await waitFor(() => (activeFork(parentId) === null ? true : null));

  await waitFor(() =>
    framesOf(join(RUNS, parentId)).some((f) => f.type === "message" && f.text?.includes("hello again")) ? true : null,
  );
});

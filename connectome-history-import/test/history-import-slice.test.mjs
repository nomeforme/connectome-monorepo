// @ts-check
/* connectome-history-import/test/history-import-slice.test.mjs —
 * slice.mjs against two cuts of a hand-made fixture state
 * (docs/harness-port/04-history-restore.md §6): a first cut imported
 * normally (write.mjs's writeRoom), then a SECOND cut of the same VEIL
 * state — a later message, a later bot reply, and an edit landing on a
 * facet the FIRST cut already holds — appended by `sliceRoom`. Every root
 * is a mkdtemp sandbox. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SALT = "a-slice-fixture-salt-long-enough";
const ALICE = { id: "4000000000000000001", name: "Alice" };
const BOT = "claude-opus-4-6";
const CHANNEL = "discord:5000000000000000001:5000000000000000002";

const T = (i) => new Date(Date.UTC(2026, 4, 1, 9, 0, i)).toISOString();
const frame = (seq, deltas, activeStream) => ({
  sequence: seq,
  timestamp: T(seq - 9000),
  uuid: `uuid-${seq}`,
  events: [],
  deltas,
  transition: {},
  ...(activeStream ? { activeStream: { streamId: activeStream, streamType: "discord" } } : {}),
});
const joinFrame = (seq) => ({
  sequence: seq,
  timestamp: T(seq - 9000),
  uuid: `uuid-${seq}`,
  events: [
    {
      topic: "stream:join",
      source: "t",
      payload: { streamId: CHANNEL, streamType: "discord", metadata: { channelName: "cuts" } },
      timestamp: T(seq - 9000),
    },
  ],
  deltas: [],
  transition: {},
});
const msgDelta = (id, author, content) => ({
  type: "addFacet",
  facet: {
    type: "event",
    id,
    content: `<${author.name}> ${content}`,
    streamId: CHANNEL,
    state: {
      eventType: "discord:message",
      source: "discord",
      authorId: author.id,
      authorName: author.name,
      messageId: id.replace("msg-", ""),
      timestamp: 1772928000000,
    },
  },
});
const speechDelta = (id, content, agentName = BOT) => ({
  type: "addFacet",
  facet: {
    type: "speech",
    id,
    content,
    streamId: CHANNEL,
    agentId: `${agentName}-discord-1`,
    agentName,
    state: { timestamp: 1772928001000 },
  },
});
const editDelta = (id, author, content) => ({
  type: "rewriteFacet",
  id,
  changes: { content: `<${author.name}> ${content}`, state: { editedAt: 1772928010000 } },
});

/** writes ONE bucket file (a batch of frames) under `dir/frame-buckets`. */
function writeBucket(dir, frames) {
  const body = {
    startSequence: frames[0].sequence,
    endSequence: frames[frames.length - 1].sequence,
    frameCount: frames.length,
    frames,
  };
  const hash = createHash("sha256").update(JSON.stringify(frames)).digest("hex");
  mkdirSync(join(dir, "frame-buckets", hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(dir, "frame-buckets", hash.slice(0, 2), `${hash.slice(2)}.json`), JSON.stringify({ hash, ...body }));
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "history-import-slice-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  return { root, state, runs: join(root, "runs"), priv: join(root, "private"), blobs: join(root, "blobs") };
}

/** re-reads the WHOLE state and returns the CHANNEL's own StreamGroup. */
async function readChannelGroup(stateDir) {
  const { listBuckets, streamFrames, emptyStats } = await import("../src/buckets.mjs");
  const { recordsOf } = await import("../src/facets.mjs");
  const { groupStreams } = await import("../src/streams.mjs");
  const buckets = listBuckets(stateDir);
  const stats = emptyStats();
  const grouper = groupStreams();
  for (const { frame: f } of streamFrames(buckets, stats)) grouper.add(recordsOf(f), "b");
  const { groups, delivered } = grouper.finish();
  return { group: groups.get(CHANNEL), delivered };
}

test("slice.mjs: a second cut appends only new items, dedupes a re-run, marks land on old facets, and each being's life gains one new imported period", async () => {
  const sb = sandbox();
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  process.env.HOUSE_BLOB_ROOT = sb.blobs;
  process.env.HOUSE_IDENTITY_SALT = SALT;

  writeBucket(sb.state, [
    joinFrame(9000),
    frame(9001, [msgDelta("msg-c1a", ALICE, "hello")], CHANNEL),
    frame(9002, [speechDelta("speech-c1", "hi there")], CHANNEL),
  ]);

  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("../src/identity.mjs");
  const { buildRoom, roomId } = await import("../src/records.mjs");
  const { writeRoom } = await import("../src/write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");
  const { sliceRoom } = await import("../src/slice.mjs");
  const houseId = process.env.HOUSE_ID || "local";
  const identity = makeIdentity({ identityFor, phoneId });

  // --- cut 1: the ordinary importer path ---
  const cut1 = await readChannelGroup(sb.state);
  identity.human({ platform: "discord", id: ALICE.id, display: ALICE.name });
  identity.bot(BOT);
  const key = identity.streamKey(cut1.group.stream);
  const id = roomId({ platform: "discord", key, slug8: roomSlug(key), firstT: cut1.group.firstT });
  const room = buildRoom({
    group: cut1.group,
    key,
    id,
    identity,
    delivered: cut1.delivered,
    forkedFrom: null,
    houseId,
    exportedT: new Date().toISOString(),
    substrate: "chronicle",
  });
  await writeRoom({ runsDir: sb.runs, stateDir: sb.state, room });
  const runDir = join(sb.runs, id);
  const clsAfterCut1 = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  assert.equal(clsAfterCut1.imported.last_seq, 9002);
  assert.equal(clsAfterCut1.imported.slices, undefined, "no slices[] before any slice has run");

  // --- lives, session 1: appended BEFORE the slice, so it only ever sees cut 1 ---
  const COVENANTS = mkdtempSync(join(tmpdir(), "history-import-slice-covenants-"));
  process.env.HOUSE_COVENANTS_DIR = COVENANTS;
  const { writeTestament, makeFakeMembrane } = await import("connectome-house/test/lib/fixtures.mjs");
  writeTestament(COVENANTS, BOT);
  const { openLife, appendPeriod, closeLife } = await import("connectome-house/src/resident-life.mjs");
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot: sb.priv, handle: BOT, speaksFor: "mock", covenant: {}, membrane });
  const first = await appendPeriod(life, runDir, { privateRoot: sb.priv });
  assert.equal(first.session, 1);
  const msgsSession1 = life.getAllMessages().filter((m) => m.metadata?.period?.session === 1);
  assert.ok(msgsSession1.length > 0);
  assert.ok(msgsSession1.every((m) => m.metadata.period.provenance === "imported"));

  // --- cut 2: a later message (itself edited within the same cut) + a later reply.
  // The edit lands on the SAME cut's own new message — records.mjs/slice.mjs both
  // now emit each edit as its OWN `edited` frame (never baked into the original's
  // text in place), so the original message frame keeps ITS OWN pre-edit text and
  // a separate `edited` frame carries the final text + edited_at.
  writeBucket(sb.state, [
    frame(9003, [msgDelta("msg-c2a", ALICE, "second message")], CHANNEL),
    frame(9004, [speechDelta("speech-c2", "second reply")], CHANNEL),
    frame(9005, [editDelta("msg-c2a", ALICE, "second message EDITED")]),
  ]);
  const cut2 = await readChannelGroup(sb.state);
  const res1 = await sliceRoom({
    runsDir: sb.runs,
    stateDir: sb.state,
    runId: id,
    group: cut2.group,
    identity,
    delivered: cut2.delivered,
    houseId,
    exportedT: new Date().toISOString(),
  });
  assert.equal(res1.applied, true, JSON.stringify(res1));
  assert.equal(res1.skippedIds, 0);

  const framesAfterSlice = readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const sliceFrame = framesAfterSlice.find((f) => f.type === "house" && f.note === "import-slice");
  assert.ok(sliceFrame, "a late-slice marker landed (the generic `house` frame, tagged by `note`)");
  assert.equal(sliceFrame.first_seq, 9003);
  assert.equal(sliceFrame.last_seq, 9005);
  assert.equal(framesAfterSlice.filter((f) => f.type === "message").length, 2, "cut 1's message + cut 2's");
  assert.equal(framesAfterSlice.filter((f) => f.type === "speech").length, 2);
  const originalMsg = framesAfterSlice.find((f) => f.type === "message" && f.text === "second message");
  assert.ok(originalMsg, "cut 2's new message keeps its OWN (pre-edit) text");
  const editedFrame = framesAfterSlice.find((f) => f.type === "edited" && f.text === "second message EDITED");
  assert.ok(editedFrame, "cut 2's own edit is its own `edited` frame");
  assert.equal(editedFrame.target, originalMsg.seq);
  assert.equal(framesAfterSlice.at(-1).type, "rested");

  const clsAfterSlice = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  assert.equal(clsAfterSlice.imported.last_seq, 9005);
  assert.equal(clsAfterSlice.imported.slices.length, 1);
  assert.equal(clsAfterSlice.imported.slices[0].house_first_seq, res1.house_first_seq);
  assert.equal(clsAfterSlice.imported.slices[0].house_last_seq, res1.house_last_seq);
  assert.equal(typeof clsAfterSlice.imported.original_last_house_seq, "number");

  // --- re-run: idempotent, nothing new ---
  const cut2Again = await readChannelGroup(sb.state);
  const res2 = await sliceRoom({
    runsDir: sb.runs,
    stateDir: sb.state,
    runId: id,
    group: cut2Again.group,
    identity,
    delivered: cut2Again.delivered,
    houseId,
    exportedT: new Date().toISOString(),
  });
  assert.equal(res2.applied, false);
  assert.match(res2.reason, /nothing new/);
  const framesAfterRerun = readFileSync(join(runDir, "frames.jsonl"), "utf8").trim().split("\n");
  assert.equal(framesAfterRerun.length, framesAfterSlice.length, "a re-run appends nothing");

  // --- lives, session 2: the slice gives the being exactly one NEW period ---
  const second = await appendPeriod(life, runDir, { privateRoot: sb.priv });
  assert.equal(second.session, 2, "the slice gives the being exactly one NEW period");
  const msgsSession2 = life.getAllMessages().filter((m) => m.metadata?.period?.session === 2);
  assert.ok(msgsSession2.length > 0);
  assert.ok(
    msgsSession2.every((m) => m.metadata.period.provenance === "imported"),
    "the sliced session is provenance:imported too — not the legacy whole-run fact",
  );
  closeLife(life);
});

test("sliceRoom's own beings gate: a slice's speech author outside it is a human, the SAME handle as Alice's real message; a real bot in it still gets speech", async () => {
  const sb = sandbox();
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  process.env.HOUSE_BLOB_ROOT = sb.blobs;
  process.env.HOUSE_IDENTITY_SALT = SALT;

  writeBucket(sb.state, [
    joinFrame(9100),
    frame(9101, [msgDelta("msg-g1a", ALICE, "hello")], CHANNEL),
    frame(9102, [speechDelta("speech-g1", "hi there")], CHANNEL),
  ]);

  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("../src/identity.mjs");
  const { buildRoom, roomId } = await import("../src/records.mjs");
  const { writeRoom } = await import("../src/write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");
  const { sliceRoom } = await import("../src/slice.mjs");
  const houseId = process.env.HOUSE_ID || "local";
  const identity = makeIdentity({ identityFor, phoneId });
  const knownBeings = new Map([[BOT, BOT]]); // "alice" (below) is NOT in it

  const cut1 = await readChannelGroup(sb.state);
  identity.human({ platform: "discord", id: ALICE.id, display: ALICE.name });
  identity.bot(BOT);
  const key = identity.streamKey(cut1.group.stream);
  const id = roomId({ platform: "discord", key, slug8: roomSlug(key), firstT: cut1.group.firstT });
  const room = buildRoom({
    group: cut1.group,
    key,
    id,
    identity,
    delivered: cut1.delivered,
    forkedFrom: null,
    houseId,
    exportedT: new Date().toISOString(),
    substrate: "chronicle",
    knownBeings,
  });
  await writeRoom({ runsDir: sb.runs, stateDir: sb.state, room });
  const runDir = join(sb.runs, id);
  const clsAfterCut1 = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  const alice = clsAfterCut1.participants.find((p) => !("kind" in p)).handle;

  // a later slice: a real bot reply (stays speech) + a HUMAN's typed
  // message recorded as a speech facet (agentName "alice", matching
  // ALICE's own display name, slug-normalized) — never a being
  writeBucket(sb.state, [
    frame(9103, [speechDelta("speech-g2", "second reply")], CHANNEL),
    frame(9104, [speechDelta("speech-alice-1", "typed by alice via a workflow", "alice")], CHANNEL),
  ]);
  const cut2 = await readChannelGroup(sb.state);
  const res = await sliceRoom({
    runsDir: sb.runs,
    stateDir: sb.state,
    runId: id,
    group: cut2.group,
    identity,
    delivered: cut2.delivered,
    houseId,
    exportedT: new Date().toISOString(),
    knownBeings,
  });
  assert.equal(res.applied, true, JSON.stringify(res));

  const clsAfterSlice = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  assert.deepEqual(clsAfterSlice.beings, [BOT], "the re-classed author never becomes a being");
  assert.equal(
    clsAfterSlice.participants.length,
    clsAfterCut1.participants.length,
    "the SAME (already-known) participant, no duplicate minted",
  );
  const framesAfterSlice = readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const reclassedFrame = framesAfterSlice.find((f) => f.text === "typed by alice via a workflow");
  assert.equal(reclassedFrame.type, "message", "a message frame, not a being's speech");
  assert.equal(reclassedFrame.by, alice, "the SAME handle as Alice's real message");
  const botFrame = framesAfterSlice.find((f) => f._text === "second reply" || f.inline === "second reply");
  assert.ok(botFrame, "the real bot's reply still landed");
  assert.equal(botFrame.type, "speech");
  assert.equal(botFrame.by, BOT);
});

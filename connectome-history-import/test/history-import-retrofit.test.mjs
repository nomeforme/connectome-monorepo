// @ts-check
/* connectome-history-import/test/history-import-retrofit.test.mjs — the
 * `--retrofit`/`--retrofit-only`/`--dry-run --retrofit` CLI flag (Step 2 of
 * the restore cutover, one flag instead of a hand script,
 * docs/harness-port/21-restore-rehearsal.md §6): a live-born fixture room
 * (built the ordinary way, then `imported` stripped — the same shape a
 * house's own live seat mints) plus a VEIL bucket for its stream, driven
 * through `cli.mjs` itself via `spawnSync` — never `sliceRoom` directly
 * (history-import-slice.test.mjs already covers that layer). Every root is
 * a mkdtemp sandbox. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.mjs");
const SALT = "a-retrofit-fixture-salt-long-enough";
const BOT = "claude-opus-4-6";

const T = (i) => new Date(Date.UTC(2026, 5, 1, 9, 0, i)).toISOString();
const channelFor = (n) => `discord:71${n}:72${n}`;
const frame = (seq, deltas, activeStream) => ({
  sequence: seq,
  timestamp: T(seq - 9000),
  uuid: `uuid-${seq}`,
  events: [],
  deltas,
  transition: {},
  ...(activeStream ? { activeStream: { streamId: activeStream, streamType: "discord" } } : {}),
});
const joinFrame = (seq, channel) => ({
  sequence: seq,
  timestamp: T(seq - 9000),
  uuid: `uuid-${seq}`,
  events: [
    {
      topic: "stream:join",
      source: "t",
      payload: { streamId: channel, streamType: "discord", metadata: { channelName: "retrofit" } },
      timestamp: T(seq - 9000),
    },
  ],
  deltas: [],
  transition: {},
});
const msgDelta = (id, channel, author, content) => ({
  type: "addFacet",
  facet: {
    type: "event",
    id,
    content: `<${author.name}> ${content}`,
    streamId: channel,
    state: {
      eventType: "discord:message",
      source: "discord",
      authorId: author.id,
      authorName: author.name,
      messageId: id.replace("msg-", ""),
      timestamp: 1780000000000,
    },
  },
});
const speechDelta = (id, channel, content) => ({
  type: "addFacet",
  facet: { type: "speech", id, content, streamId: channel, agentId: `${BOT}-discord-1`, agentName: BOT, state: { timestamp: 1780000001000 } },
});

function writeBucket(dir, frames) {
  const body = { startSequence: frames[0].sequence, endSequence: frames.at(-1).sequence, frameCount: frames.length, frames };
  const hash = createHash("sha256").update(JSON.stringify(frames)).digest("hex");
  mkdirSync(join(dir, "frame-buckets", hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(dir, "frame-buckets", hash.slice(0, 2), `${hash.slice(2)}.json`), JSON.stringify({ hash, ...body }));
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "history-import-retrofit-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  return { root, state, runs: join(root, "runs"), priv: join(root, "private"), blobs: join(root, "blobs") };
}

function runCli(sb, extra = []) {
  return spawnSync(
    process.execPath,
    [CLI, "--state", sb.state, "--out", sb.runs, "--private", sb.priv, "--blobs", sb.blobs, "--no-lives", ...extra],
    { encoding: "utf8", env: { ...process.env, HOUSE_IDENTITY_SALT: SALT } },
  );
}

/** a "live-born" room: built the ordinary way (buildRoom/writeRoom) from
 * whatever `--state` holds at this moment, then `imported` stripped —
 * simulating a room the house's own live seat minted, never touched by
 * this importer before (21-restore-rehearsal.md). `notAtRest`: drops the
 * closing `rested` frame, simulating a room mid-turn. */
async function buildLiveRoom(sb, channel, alice, { notAtRest = false } = {}) {
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  process.env.HOUSE_BLOB_ROOT = sb.blobs;
  process.env.HOUSE_IDENTITY_SALT = SALT;
  const { listBuckets, streamFrames, emptyStats } = await import("../src/buckets.mjs");
  const { recordsOf } = await import("../src/facets.mjs");
  const { groupStreams } = await import("../src/streams.mjs");
  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("../src/identity.mjs");
  const { buildRoom, roomId } = await import("../src/records.mjs");
  const { writeRoom } = await import("../src/write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");

  const buckets = listBuckets(sb.state);
  const stats = emptyStats();
  const grouper = groupStreams();
  for (const { frame: f, bucket } of streamFrames(buckets, stats)) grouper.add(recordsOf(f), bucket.hash);
  const { groups, delivered } = grouper.finish();
  const group = groups.get(channel);
  const identity = makeIdentity({ identityFor, phoneId });
  const key = identity.streamKey(group.stream);
  const id = roomId({ platform: group.platform, key, slug8: roomSlug(key), firstT: group.firstT });
  const room = buildRoom({
    group, key, id, identity, delivered, forkedFrom: null, houseId: "local",
    exportedT: new Date().toISOString(), substrate: "chronicle",
  });
  await writeRoom({ runsDir: sb.runs, stateDir: sb.state, room });
  const runDir = join(sb.runs, id);
  const clsPath = join(runDir, "class.json");
  const cls = JSON.parse(readFileSync(clsPath, "utf8"));
  delete cls.imported;
  writeFileSync(clsPath, JSON.stringify(cls, null, 2));
  const framesPath = join(runDir, "frames.jsonl");
  if (notAtRest) {
    const lines = readFileSync(framesPath, "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines.at(-1)).type, "rested", "sanity: buildRoom always closes at rest");
    writeFileSync(framesPath, `${lines.slice(0, -1).join("\n")}\n`); // drop the closing frame — mid-turn
  }
  return { id, runDir, clsPath, framesPath };
}

test("cli.mjs --retrofit appends a live-born room's earlier VEIL history as one marked slice, after the live frames — idempotent on a second run", async () => {
  const sb = sandbox();
  const channel = channelFor(1);
  const alice = { id: "8100000000000000001", name: "Alice" };
  writeBucket(sb.state, [
    joinFrame(9000, channel),
    frame(9001, [msgDelta("msg-live1", channel, alice, "already live")], channel),
    frame(9002, [speechDelta("speech-live1", channel, "already live too")], channel),
  ]);
  const room = await buildLiveRoom(sb, channel, alice);
  const framesBefore = readFileSync(room.framesPath, "utf8");

  // the older VEIL history this room never had (K4: it lands AFTER
  // whatever's already on disk, never spliced in before it)
  writeBucket(sb.state, [
    frame(9003, [msgDelta("msg-older1", channel, alice, "the older history")], channel),
    frame(9004, [speechDelta("speech-older1", channel, "the older reply")], channel),
  ]);

  const r1 = runCli(sb, ["--retrofit"]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /Retrofitted: 1 rooms, \d+ frames/, r1.stderr);

  const rawAfter = readFileSync(room.framesPath, "utf8");
  assert.equal(rawAfter.slice(0, framesBefore.length), framesBefore, "the room's own original (live) frames are untouched, in place");
  const framesAfter = rawAfter.trim().split("\n").map((l) => JSON.parse(l));
  const marker = framesAfter.find((f) => f.type === "house" && f.note === "import-slice");
  assert.ok(marker, "a late-slice marker landed after the live frames");
  assert.equal(marker.under_live, true, "flagged as a retrofit under an already-live room");
  const older = framesAfter.find((f) => f.type === "message" && f.text === "the older history");
  assert.ok(older, "the retrofit slice's own message landed");
  assert.equal(framesAfter.at(-1).type, "rested");
  const cls = JSON.parse(readFileSync(room.clsPath, "utf8"));
  assert.equal(cls.imported.retrofit, true);
  assert.equal(cls.imported.slices[0].retrofit, true);

  // idempotent: a second run finds nothing new to retrofit at all
  const r2 = runCli(sb, ["--retrofit"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stderr, /Retrofitted: 0 rooms, 0 frames/, r2.stderr);
  assert.equal(readFileSync(room.framesPath, "utf8"), rawAfter, "a re-run appends nothing");
});

test("cli.mjs --dry-run --retrofit writes nothing (no frames, no class.json change, no import lock left behind)", async () => {
  const sb = sandbox();
  const channel = channelFor(2);
  const alice = { id: "8200000000000000001", name: "Alice" };
  writeBucket(sb.state, [
    joinFrame(9100, channel),
    frame(9101, [msgDelta("msg-live2", channel, alice, "already live")], channel),
  ]);
  const room = await buildLiveRoom(sb, channel, alice);
  const framesBefore = readFileSync(room.framesPath, "utf8");
  const clsBefore = readFileSync(room.clsPath, "utf8");

  writeBucket(sb.state, [frame(9102, [msgDelta("msg-older2", channel, alice, "the older history")], channel)]);

  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--dry-run", "--retrofit", "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Retrofitted \(dry run\): 1 rooms, \d+ frames would land/, r.stderr);

  assert.equal(readFileSync(room.framesPath, "utf8"), framesBefore, "frames.jsonl is byte-identical — nothing written");
  assert.equal(readFileSync(room.clsPath, "utf8"), clsBefore, "class.json is byte-identical — nothing written");
  assert.ok(!existsSyncLock(room.runDir), "no .import.lock left on disk by a dry run");

  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /## Retrofitted \(dry run/, report);
});

test("cli.mjs --retrofit-only never mints a new room; a room mid-turn (not at rest) is skipped, with the reason, and left untouched", async () => {
  const sb = sandbox();
  const channel = channelFor(3);
  const alice = { id: "8300000000000000001", name: "Alice" };
  writeBucket(sb.state, [
    joinFrame(9200, channel),
    frame(9201, [msgDelta("msg-live3", channel, alice, "already live")], channel),
    frame(9202, [speechDelta("speech-live3", channel, "already live too")], channel),
  ]);
  const room = await buildLiveRoom(sb, channel, alice, { notAtRest: true });
  const framesBefore = readFileSync(room.framesPath, "utf8");

  const otherChannel = channelFor(4);
  writeBucket(sb.state, [
    joinFrame(9300, otherChannel),
    frame(9301, [msgDelta("msg-other1", otherChannel, alice, "a brand new stream")], otherChannel),
  ]);
  writeBucket(sb.state, [frame(9203, [msgDelta("msg-older3", channel, alice, "the older history")], channel)]);

  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--retrofit-only", "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Retrofitted: 0 rooms, 0 frames/, r.stderr);
  assert.match(r.stderr, /0 rooms written/, r.stderr, "retrofit-only never mints the brand-new stream either");

  assert.equal(readFileSync(room.framesPath, "utf8"), framesBefore, "the not-at-rest room is left untouched");
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /not at rest/, report);
  assert.equal(roomCount(sb.runs), 1, "no room minted for the brand-new stream either");
});

function existsSyncLock(runDir) {
  try {
    readFileSync(join(runDir, ".import.lock"));
    return true;
  } catch {
    return false;
  }
}
function roomCount(runsDir) {
  try {
    return readdirSync(runsDir).length;
  } catch {
    return 0;
  }
}

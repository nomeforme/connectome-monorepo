// @ts-check
/* connectome-history-import/test/history-import-authors.test.mjs — the
 * beings/human re-classing fix (src/beings.mjs, src/identity.mjs's
 * `humanFromSpeechAuthor`, src/records.mjs's `buildRoom` split of the
 * `speech` branch): a substream/workflow stream can record a HUMAN's
 * typed messages as speech facets whose `agentName` is the human's own
 * display handle — an importer that treats every speech author as a bot
 * mints a being out of a person. Split from history-import.test.mjs (near
 * its own 400-line file budget) rather than grown there. Every root is a
 * mkdtemp sandbox; synthetic ids/names only (555-fixture numbers), never
 * real data. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.mjs");
const SALT = "a-fixture-salt-long-enough-0002";

// synthetic identities — shapes only, no real person or server
const KAY = { id: "5550000001", name: "Kay Keeper" }; // a human, Discord id
const BOT = "claude-fixture-5"; // a real bot's own model-slug agent name
const CHANNEL = "discord:5550000100:5550000101";
const SUBSTREAM = "substream:workflow-1";

const T = (i) => new Date(Date.UTC(2026, 2, 2, 9, 0, i)).toISOString();
const ev = (seq, topic, payload) => ({
  sequence: seq,
  timestamp: T(seq - 3000),
  uuid: `uuid-${seq}`,
  events: [{ topic, source: "t", payload, timestamp: T(seq - 3000) }],
  deltas: [],
  transition: {},
});
const delta = (seq, streamId, d) => ({
  sequence: seq,
  timestamp: T(seq - 3000),
  uuid: `uuid-${seq}`,
  activeStream: { streamId, streamType: "discord" },
  events: [],
  deltas: [d],
  transition: {},
});
const msg = (id, stream, author, content) => ({
  type: "addFacet",
  facet: {
    type: "event",
    id,
    content: `<${author.name}> ${content}`,
    streamId: stream,
    state: {
      eventType: "discord:message",
      source: "discord",
      authorId: author.id,
      authorName: author.name,
      messageId: id.replace("msg-", ""),
      channelId: stream.split(":")[2],
      timestamp: 1772430000000,
    },
  },
});
/** a speech facet with an arbitrary `agentName` — the bug this suite
 * covers: a workflow stream sometimes names a HUMAN here, not a bot. */
const speechFacet = (id, stream, content, agentName) => ({
  type: "addFacet",
  facet: {
    type: "speech",
    id,
    content,
    streamId: stream,
    agentId: `${agentName}-1`,
    agentName,
    state: { timestamp: 1772430001000 },
  },
});

function fixtureFrames() {
  return [
    ev(3000, "stream:join", {
      streamId: CHANNEL,
      streamType: "discord",
      metadata: { channelName: "ops", channelType: "text" },
    }),
    ev(3001, "stream:create", {
      streamId: SUBSTREAM,
      streamType: "discord",
      parentStreamId: CHANNEL,
      metadata: { channelName: "workflow-1", channelType: "thread" },
    }),
    delta(3002, CHANNEL, msg("msg-kay-1", CHANNEL, KAY, "hello from kay")),
    delta(3003, CHANNEL, speechFacet("speech-bot-1", CHANNEL, "hi Kay", BOT)),
    delta(3004, SUBSTREAM, speechFacet("speech-kay-1", SUBSTREAM, "typed by kay in the workflow", "kay-keeper")),
  ];
}

function writeFramesState(dir, frames) {
  const hash = createHash("sha256").update(JSON.stringify(frames)).digest("hex");
  mkdirSync(join(dir, "frame-buckets", hash.slice(0, 2)), { recursive: true });
  writeFileSync(
    join(dir, "frame-buckets", hash.slice(0, 2), `${hash.slice(2)}.json`),
    JSON.stringify({
      hash,
      startSequence: frames[0].sequence,
      endSequence: frames[frames.length - 1].sequence,
      frameCount: frames.length,
      frames,
    }),
  );
}

/** @param {ReturnType<typeof fixtureFrames>} [frames] the shared substream
 * fixture by default; a test that needs a different scenario passes its own */
function sandbox(frames = fixtureFrames()) {
  const root = mkdtempSync(join(tmpdir(), "history-import-authors-"));
  const state = join(root, "state");
  mkdirSync(state);
  writeFramesState(state, frames);
  return { root, state, runs: join(root, "runs"), priv: join(root, "private"), blobs: join(root, "blobs") };
}

/** the room whose own `class.json.room.stream` is `stream`, after a run. */
const roomFor = (sb, stream) => {
  const rooms = roomsIn(sb.runs);
  const id = rooms.find(
    (d) => JSON.parse(readFileSync(join(sb.runs, d, "class.json"), "utf8")).room.stream === stream,
  );
  return id ? { id, cls: JSON.parse(readFileSync(join(sb.runs, id, "class.json"), "utf8")) } : null;
};

/** `--beings` fixture, the fleet's own `bot-runtime/config.json` shape. */
function writeBeingsFile(dir, names) {
  const p = join(dir, "beings.json");
  writeFileSync(p, JSON.stringify({ bots: names.map((name) => ({ name })) }));
  return p;
}

function runCli(sb, extra = []) {
  return spawnSync(
    process.execPath,
    [CLI, "--state", sb.state, "--out", sb.runs, "--private", sb.priv, "--blobs", sb.blobs, ...extra],
    { encoding: "utf8", env: { ...process.env, HOUSE_IDENTITY_SALT: SALT } },
  );
}

const readFrames = (dir) =>
  readFileSync(join(dir, "frames.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const roomsIn = (runs) => readdirSync(runs).filter((d) => existsSync(join(runs, d, "class.json")));
const classesIn = (sb) => {
  const rooms = roomsIn(sb.runs);
  const byPlatform = Object.fromEntries(
    rooms.map((id) => [id, JSON.parse(readFileSync(join(sb.runs, id, "class.json"), "utf8"))]),
  );
  return {
    channel: rooms.find((id) => byPlatform[id].room.stream === CHANNEL),
    sub: rooms.find((id) => byPlatform[id].room.stream === SUBSTREAM),
    byPlatform,
  };
};

test("beings.mjs: absent file, the fleet's bots-shape, and a plain name array", async () => {
  const { loadBeings, isKnownBeing } = await import("../src/beings.mjs");
  assert.equal(loadBeings(null), null);
  assert.equal(isKnownBeing(null, "anyone"), true, "no file given -> every name is a being");
  const dir = mkdtempSync(join(tmpdir(), "history-import-beings-"));
  const botsShape = join(dir, "bots.json");
  writeFileSync(botsShape, JSON.stringify({ bots: [{ name: BOT }, { name: "another-bot" }] }));
  const s1 = loadBeings(botsShape);
  assert.ok(isKnownBeing(s1, BOT));
  assert.ok(!isKnownBeing(s1, "kay-keeper"));
  const plain = join(dir, "plain.json");
  writeFileSync(plain, JSON.stringify(["only-bot"]));
  const s2 = loadBeings(plain);
  assert.ok(isKnownBeing(s2, "only-bot"));
  assert.ok(!isKnownBeing(s2, "someone-else"));
});

test("no --beings: unchanged default (every speech author is a being) and the report carries the warning", () => {
  const sb = sandbox();
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--no-lives", "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: no --beings file given/);
  const { sub, byPlatform } = classesIn(sb);
  assert.ok(sub);
  const subCls = byPlatform[sub];
  assert.deepEqual(subCls.beings, ["kay-keeper"], "unchanged: the workflow's speech author is still a being");
  const fr = readFrames(join(sb.runs, sub));
  assert.equal(fr.find((f) => f.type === "speech" || f.type === "message").type, "speech");
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /WARNING: no `--beings` file given/);
});

test("--beings (bot-runtime/config.json shape): the workflow's speech author is a human, same handle as their real message; the report lists the re-class", () => {
  const sb = sandbox();
  const beingsPath = writeBeingsFile(sb.root, [BOT]);
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--no-lives", "--beings", beingsPath, "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  const { channel, sub, byPlatform } = classesIn(sb);
  assert.ok(channel && sub);
  const kay = byPlatform[channel].participants.find((p) => !p.kind);
  assert.ok(kay, "Kay's real message registered her as a plain (non-resident) participant");

  const subCls = byPlatform[sub];
  assert.deepEqual(subCls.beings, [], "the re-classed author never becomes a being");
  const subFrames = readFrames(join(sb.runs, sub));
  const reclassedFrame = subFrames.find((f) => f.type === "message" || f.type === "speech");
  assert.equal(reclassedFrame.type, "message", "a message frame, the same shape an inbound platform message gets");
  assert.equal(reclassedFrame.by, kay.handle, "the SAME handle as Kay's real message");
  assert.equal(reclassedFrame.external.author_id, kay.handle);
  const subParticipant = subCls.participants.find((p) => p.handle === kay.handle);
  assert.ok(subParticipant && !("kind" in subParticipant), "no kind:resident on the re-classed participant");

  // the real bot, still a being with its own speech frame
  assert.deepEqual(byPlatform[channel].beings, [BOT]);
  const chFrames = readFrames(join(sb.runs, channel));
  assert.equal(chFrames.find((f) => f.type === "speech")?.by, BOT);

  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /## Speech authors re-classed as humans/);
  assert.match(report, new RegExp(`kay-keeper.*@${kay.handle}.*1 message`));
  assert.match(report, new RegExp(`Beings file: \`${beingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
});

test("--dry-run --beings: the per-stream counts and the report already reflect the classification", () => {
  const sb = sandbox();
  const beingsPath = writeBeingsFile(sb.root, [BOT]);
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--dry-run", "--beings", beingsPath, "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  // the workflow substream's own printed line: "kay-keeper" now counts as
  // a human message, not bot speech — same as a real write would produce
  assert.match(r.stderr, /messages=1 speech=0 bots=0 humans=1/);
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /## Speech authors re-classed as humans/);
  assert.match(report, /kay-keeper \(1 message\(s\)\) — no handle yet \(dry run\)/);
});

test("a real bot in the beings file still gets speech + life; the re-classed human gets none", async () => {
  const sb = sandbox();
  const beingsPath = writeBeingsFile(sb.root, [BOT]);
  const r = runCli(sb, ["--beings", beingsPath]);
  assert.equal(r.status, 0, r.stderr);
  const { channel, byPlatform } = classesIn(sb);
  const kay = byPlatform[channel].participants.find((p) => !p.kind);
  assert.ok(existsSync(join(sb.priv, BOT, "life")), "the being's life was seeded");
  assert.ok(!existsSync(join(sb.priv, kay.handle, "life")), "no life for the re-classed human");
});

// --- "system": a VEIL workflow-stream speech author that is never a
// human NOR a being (beings.mjs's SYSTEM_AUTHORS) ---
const SYSTEM_CHANNEL = "discord:5550000400:5550000401";
function systemFixture() {
  return [
    ev(3100, "stream:join", {
      streamId: SYSTEM_CHANNEL,
      streamType: "discord",
      metadata: { channelName: "automation" },
    }),
    delta(3101, SYSTEM_CHANNEL, speechFacet("speech-bot-2", SYSTEM_CHANNEL, "on it", BOT)),
    // case-insensitive: "System", not "system"
    delta(3102, SYSTEM_CHANNEL, speechFacet("speech-system-1", SYSTEM_CHANNEL, "workflow completed", "System")),
  ];
}

test("a speech author named system (any case) is a house notice — never a human, never a being", () => {
  const sb = sandbox(systemFixture());
  const beingsPath = writeBeingsFile(sb.root, [BOT]);
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--no-lives", "--beings", beingsPath, "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  const room = roomFor(sb, SYSTEM_CHANNEL);
  assert.ok(room);
  assert.deepEqual(room.cls.beings, [BOT], "the system notice never becomes a being");
  assert.ok(
    room.cls.participants.every((p) => p.handle !== "system" && p.handle.toLowerCase() !== "system"),
    "no participant entry minted for it either",
  );
  const fr = readFrames(join(sb.runs, room.id));
  const notice = fr.find((f) => f.note === "system");
  assert.ok(notice, "the house's own notice frame");
  assert.equal(notice.type, "house");
  assert.equal(notice.text, "workflow completed");
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /System notices \(VEIL workflow automation, never a being or human\): 1/);
});

// --- a Discord DISPLAY-name alias for a being (Cyrillic/Greek-confusable
// letters standing in for Latin ones) resolves to the SAME being ---
const ALIAS_CHANNEL = "discord:5550000500:5550000501";
const BOT2 = "claude-opus-4-6"; // the mission's own fixture example
// "сlαυdе opus 4.6": с(с) α(α) υ(υ) е(е) — a display
// name a Discord client would render as a lookalike of BOT2's own name.
const ALIAS_NAME = "сlαυdе opus 4.6";
function aliasFixture() {
  return [
    ev(3200, "stream:join", {
      streamId: ALIAS_CHANNEL,
      streamType: "discord",
      metadata: { channelName: "aliases" },
    }),
    delta(3201, ALIAS_CHANNEL, speechFacet("speech-bot2-1", ALIAS_CHANNEL, "under my own name", BOT2)),
    delta(3202, ALIAS_CHANNEL, speechFacet("speech-bot2-2", ALIAS_CHANNEL, "under my display name", ALIAS_NAME)),
  ];
}

test("a bot's Discord DISPLAY name (Cyrillic/Greek confusables) resolves to the SAME being, never a second human", () => {
  const sb = sandbox(aliasFixture());
  const beingsPath = writeBeingsFile(sb.root, [BOT2]);
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--no-lives", "--beings", beingsPath, "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  const room = roomFor(sb, ALIAS_CHANNEL);
  assert.ok(room);
  assert.deepEqual(room.cls.beings, [BOT2], "one being, never a second one for the alias");
  const fr = readFrames(join(sb.runs, room.id));
  const speeches = fr.filter((f) => f.type === "speech");
  assert.equal(speeches.length, 2);
  assert.ok(
    speeches.every((f) => f.by === BOT2),
    "both speeches, same handle",
  );
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /## Display-name aliases resolved/);
  assert.match(report, new RegExp(`${ALIAS_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} → ${BOT2} \\(1\\)`));
});

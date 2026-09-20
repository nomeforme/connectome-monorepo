// @ts-check
/* connectome-history-import/test/history-import.test.mjs — the importer
 * against a tiny hand-made bucket set (synthetic ids, names and text —
 * never real data): two overlapping buckets, one Discord channel with a
 * thread (substream), one edit, one deletion, one 🫥, one attachment, one
 * bot speech pair, and a Signal group whose sender is known only by a
 * phone-shaped id. Every root is a mkdtemp sandbox; the cli's --real gate
 * is exercised against the REAL connectome-house roots without ever
 * writing there. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.mjs");
const SALT = "a-fixture-salt-long-enough-0001";

// synthetic identities — shapes only, no real person or server
const ALICE = { id: "1000000000000000001", name: "Alice" };
const BOB = { id: "1000000000000000002", name: "Bob" };
const PHONE = "+15550001234";
const BOT = "claude-opus-4-6";
const CHANNEL = "discord:2000000000000000001:2000000000000000002";
const THREAD = "discord:2000000000000000001:2000000000000000003";
const GROUP = "signal:group:ZmFrZS1ncm91cC1pZC1mb3ItdGhlLXRlc3Q=";
const BOT_PHONE = "+15550009999";
const PEER_UUID = "0f0f0f0f-1111-4222-8333-444444444444";
const DM = `signal:dm:${BOT_PHONE}:${PEER_UUID}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

const T = (i) => new Date(Date.UTC(2026, 2, 1, 12, 0, i)).toISOString();
const ev = (seq, topic, payload) => ({
  sequence: seq,
  timestamp: T(seq - 1000),
  uuid: `uuid-${seq}`,
  events: [{ topic, source: "t", payload, timestamp: T(seq - 1000) }],
  deltas: [],
  transition: {},
});
const delta = (seq, streamId, d) => ({
  sequence: seq,
  timestamp: T(seq - 1000),
  uuid: `uuid-${seq}`,
  activeStream: { streamId, streamType: "discord" },
  events: [],
  deltas: [d],
  transition: {},
});
const msg = (id, stream, author, content, extra = {}) => ({
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
      messageId: id.replace("msg-discord-", ""),
      channelId: stream.split(":")[2],
      timestamp: 1772366400000,
      ...extra,
    },
  },
});
const speech = (id, stream, content, cyclePending) => ({
  type: "addFacet",
  facet: {
    type: "speech",
    id,
    content,
    streamId: stream,
    agentId: `${BOT}-discord-1`,
    agentName: BOT,
    state: { timestamp: 1772366401000, ...(cyclePending ? { cyclePending: true } : {}) },
  },
});

/** the whole synthetic history, as frames in sequence order */
function fixtureFrames() {
  return [
    ev(1000, "stream:join", {
      streamId: CHANNEL,
      streamType: "discord",
      metadata: { channelName: "general", channelType: "text" },
    }),
    ev(1001, "stream:create", {
      streamId: THREAD,
      streamType: "discord",
      parentStreamId: CHANNEL,
      metadata: { channelName: "Bob's thread", channelType: "thread" },
    }),
    ev(1002, "discord:message", {
      authorId: ALICE.id,
      authorName: ALICE.name,
      content: "x",
      mentions: [{ id: BOB.id, username: BOB.name }],
    }),
    delta(
      1003,
      CHANNEL,
      msg(
        "msg-discord-3000000000000000001",
        CHANNEL,
        ALICE,
        `hello @${BOB.name} and <@${BOB.id}>`,
        {
          attachments: [
            {
              id: "a1",
              contentType: "image/png",
              size: PNG.length,
              blobId: PNG_SHA,
              filename: "pic.png",
            },
          ],
        },
      ),
    ),
    delta(1004, CHANNEL, speech("speech-grpc-1", CHANNEL, "let me think", true)),
    delta(1005, CHANNEL, speech("speech-grpc-2", CHANNEL, `hi ${ALICE.name}`, false)),
    ev(1006, "agent:speech:delivered", {
      facetId: "speech-grpc-2",
      platform: "discord",
      platformMessageId: "3000000000000000009",
    }),
    delta(1007, CHANNEL, msg("msg-discord-3000000000000000002", CHANNEL, BOB, "a secret")),
    delta(1008, CHANNEL, {
      type: "rewriteFacet",
      id: "msg-discord-3000000000000000001",
      changes: { content: `<${ALICE.name}> hello edited`, state: { editedAt: 1772366405000 } },
    }),
    delta(1009, CHANNEL, {
      type: "rewriteFacet",
      id: "msg-discord-3000000000000000002",
      changes: { state: { hiddenFromContext: true, hiddenReactors: [ALICE.id] } },
    }),
    delta(1010, CHANNEL, {
      type: "removeFacet",
      id: "msg-discord-3000000000000000002",
      mode: "delete",
    }),
    delta(
      1011,
      THREAD,
      msg(
        "msg-discord-3000000000000000003",
        THREAD,
        ALICE,
        `in the thread — my id is ${ALICE.id}, call ${PHONE} or +15559990000`,
      ),
    ),
    {
      ...delta(1012, GROUP, {
        type: "addFacet",
        facet: {
          type: "event",
          id: `msg-signal-${PHONE}-1772366410000`,
          content: "<Carol> from signal",
          streamId: GROUP,
          state: {
            eventType: "signal:message",
            source: "signal",
            senderId: PHONE,
            senderName: "Carol",
            groupId: GROUP.slice(13),
            groupName: "The Group",
            botPhone: "+15550009999",
            timestamp: 1772366410000,
          },
        },
      }),
      activeStream: { streamId: GROUP, streamType: "signal" },
    },
    delta(
      1013,
      GROUP,
      speech("speech-grpc-3", GROUP, `signal reply to ${PEER_UUID} via ${BOT_PHONE}`, false),
    ),
    {
      ...delta(1014, DM, {
        type: "addFacet",
        facet: {
          type: "event",
          id: `msg-signal-${PEER_UUID}-1772366420000`,
          content: "<Dave> a dm",
          streamId: DM,
          state: {
            eventType: "signal:message",
            source: "signal",
            senderId: PEER_UUID,
            senderName: "Dave",
            botPhone: BOT_PHONE,
            timestamp: 1772366420000,
          },
        },
      }),
      activeStream: { streamId: DM, streamType: "signal" },
    },
    delta(1015, DM, speech("speech-grpc-4", DM, "dm reply", false)),
  ];
}

/** two overlapping buckets (1000-1008, 1006-1013) + the blob store */
function writeState(dir) {
  const frames = fixtureFrames();
  const bucket = (fs) => {
    const body = {
      startSequence: fs[0].sequence,
      endSequence: fs[fs.length - 1].sequence,
      frameCount: fs.length,
      frames: fs,
    };
    const hash = createHash("sha256").update(JSON.stringify(fs)).digest("hex");
    mkdirSync(join(dir, "frame-buckets", hash.slice(0, 2)), { recursive: true });
    writeFileSync(
      join(dir, "frame-buckets", hash.slice(0, 2), `${hash.slice(2)}.json`),
      JSON.stringify({ hash, ...body }),
    );
    return { hash, ...body, frames: undefined };
  };
  const refs = [bucket(frames.slice(0, 9)), bucket(frames.slice(6))];
  writeFileSync(join(dir, "bucket-refs-index.json"), JSON.stringify({ version: 1, refs }));
  mkdirSync(join(dir, "blobs", PNG_SHA.slice(0, 2)), { recursive: true });
  writeFileSync(join(dir, "blobs", PNG_SHA.slice(0, 2), `${PNG_SHA}.bin`), PNG);
  writeFileSync(
    join(dir, "blobs", PNG_SHA.slice(0, 2), `${PNG_SHA}.json`),
    JSON.stringify({ contentType: "image/png", filename: "pic.png", sizeBytes: PNG.length }),
  );
  return frames.length;
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "history-import-"));
  const state = join(root, "state");
  mkdirSync(state);
  writeState(state);
  return {
    root,
    state,
    runs: join(root, "runs"),
    priv: join(root, "private"),
    blobs: join(root, "blobs"),
  };
}

function runCli(sb, extra = [], env = {}) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      "--state",
      sb.state,
      "--out",
      sb.runs,
      "--private",
      sb.priv,
      "--blobs",
      sb.blobs,
      ...extra,
    ],
    { encoding: "utf8", env: { ...process.env, HOUSE_IDENTITY_SALT: SALT, ...env } },
  );
}

const readFrames = (dir) =>
  readFileSync(join(dir, "frames.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const roomsIn = (runs) => readdirSync(runs).filter((d) => existsSync(join(runs, d, "class.json")));

test("buckets: overlapping buckets yield every frame once, in order", async () => {
  const sb = sandbox();
  const { listBuckets, streamFrames, emptyStats } = await import("../src/buckets.mjs");
  const buckets = listBuckets(sb.state);
  assert.equal(buckets.length, 2);
  const stats = emptyStats();
  const seqs = [...streamFrames(buckets, stats)].map(({ frame }) => frame.sequence);
  assert.deepEqual(
    seqs,
    Array.from({ length: 16 }, (_, i) => 1000 + i),
  );
  assert.equal(stats.frames_read, 19);
  assert.equal(stats.duplicates, 3);
});

test("the importer writes the channel, its thread as a forked room, and the signal group — exact frames", () => {
  const sb = sandbox();
  const r = runCli(sb, ["--no-lives"]);
  assert.equal(r.status, 0, r.stderr);
  const rooms = roomsIn(sb.runs);
  assert.equal(rooms.length, 4);
  const byPlatform = Object.fromEntries(
    rooms.map((id) => [id, JSON.parse(readFileSync(join(sb.runs, id, "class.json"), "utf8"))]),
  );
  const channel = rooms.find((id) => byPlatform[id].room.stream === CHANNEL);
  const thread = rooms.find((id) => byPlatform[id].room.stream === THREAD);
  const group = rooms.find((id) => byPlatform[id].room.stream === GROUP);
  assert.ok(channel && thread && group);
  // stamped with the first message's own platform time, not the import's
  assert.match(channel, /^room-discord-[0-9a-f]{8}-2026-03-01T12-00-00-[0-9a-f]{4}$/);

  const frAll = readFrames(join(sb.runs, channel));
  // the channel is a fork PARENT: write.mjs's markBranchOnParent appends a
  // branch.created frame to it once the thread is written, at a fractional
  // seq (frames-io.mjs's houseFrameSeq) — split it off before the
  // contiguous-seq check below.
  const branchFrame = frAll.find((f) => f.type === "branch.created");
  assert.ok(branchFrame, "the parent's own record carries the fork, not only the child's pointer");
  assert.equal(branchFrame.id, thread);
  assert.ok(!Number.isInteger(branchFrame.seq), "appended past the room's own closing frame");
  const fr = frAll.filter((f) => f.type !== "branch.created");
  assert.deepEqual(
    fr.map((f) => f.seq),
    fr.map((_, i) => i),
    "seq contiguous from 0",
  );
  assert.deepEqual(
    fr.map((f) => f.type),
    [
      "room.mounted",
      "participant.joined",
      "message",
      "media.attached",
      "participant.joined",
      "speech",
      "speech",
      "participant.joined",
      "message",
      "edited",
      "hidden",
      "retracted",
      "rested",
    ],
  );
  const cls = byPlatform[channel];
  const alice = cls.participants[0].handle;
  const bob = cls.participants[2].handle;
  assert.match(alice, /^discord-[a-z2-7]{6}$/, "a human is a salted pseudonym, never a snowflake");
  assert.equal(fr[0].harness.model, BOT);
  assert.deepEqual(fr[0].imported, {
    source: "veil",
    stream: CHANNEL,
    bucket_range: [1003, 1010],
  });
  assert.deepEqual(fr[0].harness.walkers, [{ name: BOT, model: BOT }]);
  // the original message keeps its OWN (pre-edit) text; the edit is its
  // own `edited` frame pointing back at it
  assert.equal(fr[2].by, alice);
  assert.equal(fr[2].external.author_id, alice);
  assert.equal(fr[2].external.message_id, "3000000000000000001");
  assert.equal(fr[9].type, "edited");
  assert.equal(fr[9].target, fr[2].seq);
  assert.equal(fr[9].text, "hello edited");
  assert.equal(fr[9].edited_at, "2026-03-01T12:00:05.000Z");
  assert.equal(fr[3].path, `blob/${PNG_SHA}`);
  assert.equal(fr[3].requested_by, "human");
  assert.equal(fr[3].seen_by_model, false);
  assert.ok(
    existsSync(join(sb.blobs, "blobs", PNG_SHA.slice(0, 2), `${PNG_SHA}.png`)),
    "bytes landed in the house blob root",
  );
  assert.ok(existsSync(join(sb.blobs, "refs", `${PNG_SHA}.jsonl`)), "and the room's reference");
  assert.equal(fr[4].kind, "resident");
  assert.equal(fr[5].delivered_mid_turn, true);
  assert.equal(fr[6].delivered_mid_turn, undefined, "a delivered, cycle-final speech carries no mid-turn flag");
  assert.equal(
    fr[6].external.message_id,
    "3000000000000000009",
    "a delivered speech carries the platform message id",
  );
  assert.equal(
    fr[6].inline,
    "hi Alice",
    "a bot addressing a human by name keeps the name — it is the bot's own words",
  );
  assert.equal(fr[8].text, "a secret");
  assert.deepEqual(fr[10], {
    seq: 10,
    t: fr[10].t,
    type: "hidden",
    target: 8,
    by: [alice],
    reason: "redacted",
    // docs/harness-port/25-outbound-guardrail.md rule 3: every frame this
    // importer writes now carries its own outbound-ineligibility marker.
    origin: "import",
  });
  assert.deepEqual(fr[11], { seq: 11, t: fr[11].t, type: "retracted", target: 8, reason: "deleted", origin: "import" });
  assert.equal(fr[12].turns, 2);
  const hello = fr[2].text;
  assert.ok(!hello.includes(BOB.id), "no raw snowflake in text");

  // the thread forks from the channel's last frame before it (its own
  // frame — not the branch.created marker appended to the parent AFTER):
  // seq 11 is the channel's `retracted` frame (veilSeq 1010), the last one
  // at or before the thread's own first veilSeq (1011).
  const tf = readFrames(join(sb.runs, thread));
  assert.deepEqual(tf[0].forkedFrom, { run: channel, seq: 11 });
  assert.deepEqual(byPlatform[thread].forkedFrom, { run: channel, seq: 11 });
  // ids and numbers quoted in prose become handles / a placeholder
  assert.equal(
    tf[2].text,
    `in the thread — my id is @${alice}, call @${byPlatform[group].participants[0].handle} or [a phone number]`,
  );
  assert.equal(byPlatform[thread].visibility, "public");
  // a title carrying a person's name is scrubbed to the handle, unconditionally
  assert.equal(byPlatform[thread].room.title, `#@${bob}'s thread`);

  // class.json: room + imported + beings; provenance markers
  assert.equal(cls.class, "room");
  assert.equal(cls.live_origin, false);
  assert.deepEqual(cls.beings, [BOT]);
  assert.equal(cls.being, BOT);
  assert.equal(cls.owner, BOT);
  assert.equal(cls.imported.first_seq, 1003);
  assert.equal(cls.imported.last_seq, 1010);
  assert.equal(cls.imported.buckets, 2);
  assert.ok(cls.imported.lost.includes("replies"));
  assert.ok(!cls.imported.lost.includes("edit-history"), "every edit is now its own append — not lost");
  assert.equal(cls.room.title, "#general");
  const run = JSON.parse(readFileSync(join(sb.runs, channel, "run.json"), "utf8"));
  assert.equal(run.model, BOT);
  assert.equal(run.usage, null);
  assert.equal(run.state, "rested");
  assert.equal(run.sessions[0].imported, true);
  const ext = readFileSync(join(sb.runs, channel, "external.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(ext.length, 4, "one row per ORIGINAL item (2 messages + 2 speech) — an edit/hide/retract adds no external row");
  assert.ok(ext.every((l) => l.author_id === alice || l.author_id === bob || l.author_id === BOT));

  // the signal group: private, the phone-only sender pseudonymous, the stream key kept
  const gcls = byPlatform[group];
  const gfr = readFrames(join(sb.runs, group));
  assert.match(
    gfr.find((f) => f.type === "speech").inline,
    /^signal reply to @signal-[a-z2-7]{6} via @claude-opus-4-6$/,
  );
  assert.equal(gcls.visibility, "private");
  assert.equal(gcls.room.title, "The Group");
  assert.match(gcls.participants[0].handle, /^signal-[a-z2-7]{6}$/);

  // the signal DM: its key is canonicalStream's (stream-key.mjs) — a bare
  // digest of the peer for the one (primary) bot phone this import saw,
  // never the bot's number or the peer's uuid
  const dm = rooms.find((id) => byPlatform[id].room.stream.startsWith("signal:dm:"));
  assert.ok(dm);
  const dmKey = byPlatform[dm].room.stream;
  assert.match(dmKey, /^signal:dm:[0-9a-f]{12}$/, dmKey);
  assert.equal(byPlatform[dm].imported.stream, dmKey);
});

test("the PII invariant: a phone-shaped sender id, raw snowflakes and display-name prefixes reach no output file", () => {
  const sb = sandbox();
  const r = runCli(sb, ["--no-lives"]);
  assert.equal(r.status, 0, r.stderr);
  const digits = PHONE.slice(1);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const offenders = [];
  for (const p of [...walk(sb.runs), ...walk(sb.blobs)]) {
    if (!/\.(jsonl?|txt)$/.test(p)) continue;
    const t = readFileSync(p, "utf8");
    if (t.includes(digits)) offenders.push(`phone digits in ${p}`);
    if (t.includes(ALICE.id) || t.includes(BOB.id)) offenders.push(`author snowflake in ${p}`);
    if (t.includes(PEER_UUID) || t.includes(BOT_PHONE.slice(1)))
      offenders.push(`signal uuid/number in ${p}`);
    if (t.includes(`<${ALICE.name}>`) || t.includes(`<${BOB.name}>`))
      offenders.push(`author prefix in ${p}`);
  }
  assert.deepEqual(offenders, []);
  // the identity map (private, keeper-owned) keys on the phone's sha256 — never the number
  const map = JSON.parse(readFileSync(join(sb.priv, "identity-map.json"), "utf8"));
  assert.ok(!JSON.stringify(map).includes(digits));
  assert.ok(Object.keys(map.entries).some((k) => /^signal:[0-9a-f]{64}$/.test(k)));
});

test("idempotent: a second run over the same --out skips every stream already imported", () => {
  const sb = sandbox();
  assert.equal(runCli(sb, ["--no-lives"]).status, 0);
  const before = roomsIn(sb.runs).sort();
  const r = runCli(sb, ["--no-lives"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stderr,
    /0 rooms written, 4 skipped/,
    "the signal DM's rewritten key is stable across runs",
  );
  assert.deepEqual(roomsIn(sb.runs).sort(), before);
});

test("--real gate: pointing --out at the house's real runs dir without --real refuses before reading anything", () => {
  const sb = sandbox();
  const real = resolve(HERE, "..", "..", "connectome-house", "runs");
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      "--state",
      sb.state,
      "--out",
      real,
      "--private",
      sb.priv,
      "--blobs",
      sb.blobs,
      "--no-lives",
    ],
    { encoding: "utf8", env: { ...process.env, HOUSE_IDENTITY_SALT: SALT } },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing: --runs resolve\(s\) to the house's REAL runs root/);
  assert.ok(!existsSync(sb.runs), "nothing was written to the sandbox either");
});

test("--dry-run writes nothing and counts per stream; a missing salt refuses a real write", () => {
  const sb = sandbox();
  const r = runCli(sb, ["--dry-run"], { HOUSE_IDENTITY_SALT: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /dry run: 4 streams would be written/);
  assert.match(
    r.stderr,
    /discord\s+frames=\d+ messages=2 speech=2 bots=1 humans=2 attachments=1 edits=1 deletions=1 redactions=1/,
  );
  assert.ok(!existsSync(sb.runs));
  const r2 = runCli(sb, [], { HOUSE_IDENTITY_SALT: "" });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /HOUSE_IDENTITY_SALT is not set/);
});

test("--dry-run --report writes a report file and nothing else", () => {
  const sb = sandbox();
  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--dry-run", "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(reportPath));
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /^# connectome-history-import — dry run/);
  assert.match(report, /streams with messages: 4/);
  assert.ok(!existsSync(sb.runs), "a dry run writes only the report, nothing under --out");
});

test("findRoom finds an imported record by {platform, stream}, and its state lets a reopen take it as session n+1", async () => {
  const sb = sandbox();
  assert.equal(runCli(sb, ["--no-lives"]).status, 0);
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  const { findRoom } = await import("connectome-house/src/room-index.mjs");
  const hit = findRoom({ platform: "discord", stream: CHANNEL });
  assert.ok(hit, "the imported channel is a room the house finds by its stream");
  const run = JSON.parse(readFileSync(join(sb.runs, hit.id, "run.json"), "utf8"));
  assert.equal(
    run.state,
    "rested",
    "rested, so a reopen takes it as session n+1 rather than minting anew",
  );
  assert.equal(findRoom({ platform: "signal", stream: GROUP })?.platform, "signal");
});

test("lives: an imported room appends as a period with provenance:imported; retracted/hidden are house lines, never text", async () => {
  const sb = sandbox();
  assert.equal(runCli(sb, ["--no-lives"]).status, 0);
  const COVENANTS = mkdtempSync(join(tmpdir(), "history-import-covenants-"));
  process.env.HOUSE_COVENANTS_DIR = COVENANTS;
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  const { writeTestament, makeFakeMembrane } = await import("connectome-house/test/lib/fixtures.mjs");
  writeTestament(COVENANTS, BOT);
  const { openLife, appendPeriod, closeLife, compileFor } = await import(
    "connectome-house/src/resident-life.mjs"
  );
  const { provenanceOf } = await import("connectome-house/src/life-entries.mjs");
  const { membrane } = makeFakeMembrane();
  const life = await openLife({
    privateRoot: sb.priv,
    handle: BOT,
    speaksFor: "mock",
    covenant: {},
    membrane,
  });
  const rooms = roomsIn(sb.runs);
  const channel = rooms.find(
    (id) =>
      JSON.parse(readFileSync(join(sb.runs, id, "class.json"), "utf8")).room.stream === CHANNEL,
  );
  assert.equal(provenanceOf(join(sb.runs, channel)), "imported");
  const res = await appendPeriod(life, join(sb.runs, channel), { privateRoot: sb.priv });
  assert.equal(res.mode, "trunk");
  const msgs = life.getAllMessages().filter((m) => m.metadata?.period?.run === channel);
  assert.ok(msgs.length >= 5);
  assert.ok(msgs.every((m) => m.metadata.period.provenance === "imported"));
  const texts = msgs.map((m) => m.content.map((b) => b.text ?? "").join(""));
  assert.ok(texts.some((t) => t === "[a message was withdrawn]"));
  assert.ok(texts.some((t) => /^\[hidden by @discord-[a-z2-7]{6}\]$/.test(t)));
  assert.ok(
    !texts.some((t) => t.includes("a secret") && t.includes("withdrawn")),
    "the tombstone never carries the text",
  );
  // both bot speeches (cycle-pending included) are the being's own words in its life
  assert.ok(texts.some((t) => t.startsWith("let me think")));
  assert.ok(texts.some((t) => t.startsWith("hi Alice")));
  const compiled = await compileFor(life, join(sb.runs, channel), {});
  assert.ok(compiled.messages.length > 0);
  closeLife(life);
  // a lived (non-imported) run reads as "lived"
  const lived = mkdtempSync(join(tmpdir(), "history-import-lived-"));
  writeFileSync(join(lived, "class.json"), JSON.stringify({ class: "room" }));
  assert.equal(provenanceOf(lived), "lived");
});

test("a room the HOUSE minted live (no `imported` field at all) is found by the house's own findRoom and skipped — never a duplicate, never rewritten; slice.mjs (the retrofit case) is where its earlier VEIL history actually lands", async () => {
  const sb = sandbox();
  process.env.HOUSE_RUNS_DIR = sb.runs;
  process.env.HOUSE_PRIVATE_DIR = sb.priv;
  process.env.HOUSE_BLOB_ROOT = sb.blobs;
  process.env.HOUSE_IDENTITY_SALT = SALT;

  // build the CHANNEL's room the ordinary way, then strip `imported` —
  // simulating a room the house's own live seat minted, never touched by
  // this importer before (docs/harness-port/21-restore-rehearsal.md).
  const { listBuckets, streamFrames, emptyStats } = await import("../src/buckets.mjs");
  const { recordsOf } = await import("../src/facets.mjs");
  const { groupStreams } = await import("../src/streams.mjs");
  const buckets = listBuckets(sb.state);
  const stats = emptyStats();
  const grouper = groupStreams();
  for (const { frame: f, bucket } of streamFrames(buckets, stats)) grouper.add(recordsOf(f), bucket.hash);
  const { groups, delivered } = grouper.finish();
  const channelGroup = groups.get(CHANNEL);

  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("../src/identity.mjs");
  const { buildRoom, roomId } = await import("../src/records.mjs");
  const { writeRoom } = await import("../src/write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");
  const identity = makeIdentity({ identityFor, phoneId });
  const key = identity.streamKey(channelGroup.stream);
  const id = roomId({ platform: channelGroup.platform, key, slug8: roomSlug(key), firstT: channelGroup.firstT });
  const room = buildRoom({
    group: channelGroup,
    key,
    id,
    identity,
    delivered,
    forkedFrom: null,
    houseId: "local",
    exportedT: new Date().toISOString(),
    substrate: "chronicle",
  });
  await writeRoom({ runsDir: sb.runs, stateDir: sb.state, room });
  const runDir = join(sb.runs, id);
  const clsPath = join(runDir, "class.json");
  const cls = JSON.parse(readFileSync(clsPath, "utf8"));
  delete cls.imported;
  writeFileSync(clsPath, JSON.stringify(cls, null, 2));
  const framesBefore = readFileSync(join(runDir, "frames.jsonl"), "utf8");
  const classBefore = readFileSync(clsPath, "utf8");
  const roomsBefore = roomsIn(sb.runs).sort();

  const reportPath = join(sb.root, "report.md");
  const r = runCli(sb, ["--no-lives", "--streams", CHANNEL, "--report", reportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /0 rooms written, 1 skipped/);
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /live-minted room/, report);

  assert.deepEqual(roomsIn(sb.runs).sort(), roomsBefore, "no duplicate room minted for the same stream");
  assert.equal(
    readFileSync(join(runDir, "frames.jsonl"), "utf8"),
    framesBefore,
    "the live-minted room's record is untouched",
  );
  assert.equal(
    readFileSync(clsPath, "utf8"),
    classBefore,
    "class.json untouched — no imported field silently added by the bulk sweep",
  );
});

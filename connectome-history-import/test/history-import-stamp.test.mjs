// @ts-check
/* connectome-history-import/test/history-import-stamp.test.mjs —
 * `stamp-imported.mjs` / the `--stamp-imported` CLI flag
 * (docs/harness-port/26-retro-stamp.md): retroactively stamping
 * `origin: "import"` (25-outbound-guardrail.md rule 3) onto frames this
 * package wrote before that marker existed, without ever touching a
 * frame the live house wrote. Fixtures are hand-built room directories
 * (class.json/run.json/frames.jsonl) — this module never touches VEIL
 * state, so there is no bucket layer to fake. Every root is a mkdtemp
 * sandbox; nothing here ever touches a real connectome-house deployment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRoom, planRoom, stampImported, stampLine } from "../src/stamp-imported.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.mjs");

function sandbox() {
  return mkdtempSync(join(tmpdir(), "history-import-stamp-"));
}

function writeFrames(runDir, frames) {
  writeFileSync(join(runDir, "frames.jsonl"), `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
}

function readFrames(runDir) {
  return readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function rawFrames(runDir) {
  return readFileSync(join(runDir, "frames.jsonl"), "utf8");
}

/** a wholesale room this importer minted from scratch — one imported
 * session, no live activity ever. */
function makeWholesaleRoom(runsDir, id, frames) {
  const runDir = join(runsDir, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({
      imported: { source: "veil", stream: `discord:${id}`, platform: "discord", first_seq: 0, last_seq: 100, exported_t: "2026-09-20T00:29:02.250Z", lost: [] },
    }),
  );
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ runId: id, state: "rested", sessions: [{ imported: true, started: "2026-01-01T00:00:00Z", ended: "2026-01-02T00:00:00Z" }] }),
  );
  writeFrames(runDir, frames);
  return runDir;
}

/** the exact incident shape: live frames before the retrofit, the
 * retrofit's own appended slice, and (for the "live frames after" case)
 * more live frames appended past it — none of the three carry `origin`,
 * matching the pre-rule-3 code that actually ran. */
function makeRetrofitRoom(runsDir, id, { before, sliceRange, after = [], markerSeq }) {
  const runDir = join(runsDir, id);
  mkdirSync(runDir, { recursive: true });
  const [houseFirst, houseLast] = sliceRange;
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({
      imported: {
        source: "veil",
        stream: `signal:group:${id}`,
        platform: "signal",
        first_seq: 25134,
        last_seq: 371976,
        exported_t: "2026-09-20T00:31:46.274Z",
        lost: [],
        retrofit: true,
        original_last_house_seq: before.at(-1)?.seq ?? 0,
        slices: [
          {
            source: "veil",
            stream: `signal:group:${id}`,
            first_seq: 25134,
            last_seq: 371976,
            house_first_seq: houseFirst,
            house_last_seq: houseLast,
            exported_t: "2026-09-20T00:31:46.274Z",
            retrofit: true,
          },
        ],
      },
    }),
  );
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: id, state: "rested", sessions: [] }));
  // markerSeq defaults to houseFirst (the "no offset bug" shape); a caller
  // reproducing the real 2026-09-20 offset bug (module header) passes a
  // different markerSeq, still spanned by the SAME recorded (houseFirst,
  // houseLast) span length, matching what was found on tonight's own disk.
  const realMarkerSeq = markerSeq ?? houseFirst;
  const span = houseLast - houseFirst;
  const slice = [];
  for (let i = 0, s = realMarkerSeq; s <= realMarkerSeq + span; i++, s = realMarkerSeq + i) {
    slice.push({
      seq: s,
      t: "2026-06-16T23:50:35.103Z",
      type: s === realMarkerSeq ? "house" : "speech",
      ...(s === realMarkerSeq
        ? { note: "import-slice", stream: `signal:group:${id}`, exported_t: "2026-09-20T00:31:46.274Z" }
        : { by: "sam" }),
    });
  }
  writeFrames(runDir, [...before, ...slice, ...after]);
  return runDir;
}

// ---------- classifyRoom ----------

test("classifyRoom: no imported field at all -> not-imported (a pure live room, never touched)", () => {
  const runs = sandbox();
  const runDir = join(runs, "live-room");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify({ room: { platform: "discord" } }));
  assert.deepEqual(classifyRoom(runDir), { kind: "not-imported" });
});

test("classifyRoom: imported present, retrofit not true -> wholesale", () => {
  const runs = sandbox();
  const runDir = makeWholesaleRoom(runs, "room-discord-abc", [{ seq: 0, t: "2026-01-01T00:00:00Z", type: "room.mounted" }]);
  assert.equal(classifyRoom(runDir).kind, "wholesale");
});

test("classifyRoom: imported.retrofit true with a slices[] marker -> retrofit, slices[] carries house_first_seq/house_last_seq", () => {
  const runs = sandbox();
  const runDir = makeRetrofitRoom(runs, "room-a", {
    before: [{ seq: 0, t: "2026-09-19T16:00:00Z", type: "room.mounted" }, { seq: 5, t: "2026-09-19T20:00:00Z", type: "speech", by: "sam" }],
    sliceRange: [13.5, 20.5],
  });
  const info = classifyRoom(runDir);
  assert.equal(info.kind, "retrofit");
  assert.equal(info.hasMarker, true);
  assert.equal(info.slices.length, 1);
  assert.equal(info.slices[0].house_first_seq, 13.5);
  assert.equal(info.slices[0].house_last_seq, 20.5);
});

// ---------- stampLine: byte-exact splice ----------

test("stampLine: appends origin as the LAST key, byte-exact otherwise — including a string value containing a literal '}'", () => {
  const line = '{"seq":0,"t":"2026-01-01T00:00:00Z","type":"message","text":"ends with brace}","harness":{"model":"x"}}';
  const out = stampLine(line);
  assert.equal(out, '{"seq":0,"t":"2026-01-01T00:00:00Z","type":"message","text":"ends with brace}","harness":{"model":"x"},"origin":"import"}');
  const parsed = JSON.parse(out);
  assert.equal(parsed.origin, "import");
  assert.equal(parsed.text, "ends with brace}");
  assert.deepEqual(parsed.harness, { model: "x" });
});

// ---------- wholesale: every frame stamped, unless mixed with live sessions ----------

test("stampImported: a wholesale (created) room gets origin on every frame, dry-run changes nothing, real does, second real is a no-op", () => {
  const runs = sandbox();
  const frames = [
    { seq: 0, t: "2026-03-07T21:04:54.283Z", type: "room.mounted", platform: "discord" },
    { seq: 1, t: "2026-03-07T21:04:54.283Z", type: "participant.joined", handle: "discord-abc" },
    { seq: 2, t: "2026-03-07T21:05:00.000Z", type: "message", by: "discord-abc", text: "hi" },
    { seq: 3, t: "2026-03-07T21:05:10.000Z", type: "rested", turns: 1, reaches: 0 },
  ];
  const runDir = makeWholesaleRoom(runs, "room-discord-wholesale", frames);
  const before = rawFrames(runDir);

  const dry = stampImported({ runsDir: runs, dryRun: true });
  assert.equal(dry.totals.roomsTouched, 1);
  assert.equal(dry.totals.framesStamped, 4);
  assert.equal(rawFrames(runDir), before, "dry-run must not touch the file");

  const real = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(real.totals.framesStamped, 4);
  const stamped = readFrames(runDir);
  assert.ok(stamped.every((f) => f.origin === "import"));
  assert.equal(stamped[2].text, "hi", "everything else on the line is unchanged");

  // no leftover tmp file from the atomic write
  assert.deepEqual(readdirSync(runDir).sort(), ["class.json", "frames.jsonl", "run.json"]);

  const again = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(again.totals.framesStamped, 0, "idempotent: nothing left to stamp");
  assert.equal(again.totals.framesAlreadyStamped, 4);
  assert.equal(again.totals.roomsTouched, 0);
});

test("stampImported: a wholesale room whose run.json shows a NON-imported session is left untouched (wholesale-mixed)", () => {
  const runs = sandbox();
  const runDir = makeWholesaleRoom(runs, "room-discord-mixed", [
    { seq: 0, t: "2026-03-07T21:04:54.283Z", type: "room.mounted" },
    { seq: 1, t: "2026-09-20T00:40:00.000Z", type: "speech", by: "claude-opus-4-6" },
  ]);
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  run.sessions.push({ started: "2026-09-20T00:40:00.000Z", ended: "2026-09-20T00:41:00.000Z" }); // no `imported: true` — a live session
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
  const before = rawFrames(runDir);

  const res = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(res.totals.roomsSkippedMixed, 1);
  assert.equal(res.totals.framesStamped, 0);
  assert.equal(rawFrames(runDir), before, "a mixed wholesale room is never rewritten");
});

// ---------- retrofit: only the slice's own range, never the live frames before/after ----------

test("stampImported: a retrofitted room stamps ONLY the slice's house_first_seq..house_last_seq range — the exact incident shape (live before, live after)", () => {
  const runs = sandbox();
  const before = [
    { seq: 0, t: "2026-09-19T16:00:00.000Z", type: "room.mounted", platform: "signal" },
    { seq: 5, t: "2026-09-19T20:00:00.000Z", type: "speech", by: "sam" },
  ];
  const after = [
    { seq: 21, t: "2026-09-20T00:49:20.600Z", type: "speech", by: "sam" }, // a genuinely NEW, post-retrofit live turn
  ];
  const runDir = makeRetrofitRoom(runs, "room-signal-incident", { before, sliceRange: [13.5, 20.5], after });

  const dry = stampImported({ runsDir: runs, dryRun: true });
  // slice frames: seq 13.5..20.5 step 1 -> 13.5,14.5,...,20.5 = 8 frames
  assert.equal(dry.totals.framesStamped, 8);

  stampImported({ runsDir: runs, dryRun: false });
  const frames = readFrames(runDir);
  const bySeq = new Map(frames.map((f) => [f.seq, f]));
  for (const f of before) assert.equal(bySeq.get(f.seq).origin, undefined, `pre-retrofit live frame seq ${f.seq} must never be stamped`);
  for (const f of after) assert.equal(bySeq.get(f.seq).origin, undefined, `post-retrofit live frame seq ${f.seq} must never be stamped`);
  for (let s = 13.5; s <= 20.5; s += 1) assert.equal(bySeq.get(s).origin, "import", `retrofit frame seq ${s} must be stamped`);
});

test("stampImported: the range is GROUNDED against the actual marker frame, not the recorded (buggy, offset) house_first_seq/house_last_seq — the real 2026-09-20 shape (bab97539…: original_last_house_seq 4.998046875, recorded house_first_seq 5.998046875, ACTUAL marker frame at seq 5)", () => {
  const runs = sandbox();
  const before = [
    { seq: 0, t: "2026-09-19T16:28:41.976Z", type: "room.mounted", platform: "signal" },
    { seq: 4.998046875, t: "2026-09-19T17:43:45.582Z", type: "rested" },
  ];
  // recorded bounds (as class.json actually holds them, per slice.mjs's own
  // buggy startSeq math) vs. the REAL on-disk marker seq (5, matching
  // Math.ceil(original_last_house_seq) — never assumed by this module,
  // only observed): a 0.998046875 offset, exactly like the real room.
  const runDir = makeRetrofitRoom(runs, "room-signal-offset-bug", {
    before,
    sliceRange: [5.998046875, 6823.998046875],
    markerSeq: 5,
  });

  const info = classifyRoom(runDir);
  assert.equal(info.slices[0].house_first_seq, 5.998046875, "the recorded (buggy) bound is still what class.json holds");

  const plan = planRoom(runDir);
  assert.deepEqual(plan.markerGrounded, [true], "the marker frame was found and grounded the range");
  // real span: 6823.998046875 - 5.998046875 = 6818; real marker seq 5 ->
  // real range [5, 6823] inclusive = 6819 frames (matches the room's own
  // actual on-disk shape exactly, verified against the box).
  assert.equal(plan.stamped, 6819);

  stampImported({ runsDir: runs, dryRun: false });
  const frames = readFrames(runDir);
  const bySeq = new Map(frames.map((f) => [f.seq, f]));
  assert.equal(bySeq.get(0).origin, undefined, "the room.mounted frame, before the retrofit, is never stamped");
  assert.equal(bySeq.get(4.998046875).origin, undefined, "the pre-retrofit closing frame is never stamped");
  assert.equal(bySeq.get(5).origin, "import", "the ACTUAL marker frame (seq 5, not the recorded 5.998046875) is stamped");
  assert.equal(bySeq.get(6823).origin, "import", "the retrofit's own closing frame (real span end) is stamped");
});

test("stampImported: retrofit hasMarker true but NO matching marker frame on disk falls back to the recorded bounds verbatim, flagged markerGrounded:false", () => {
  const runs = sandbox();
  const runDir = join(runs, "room-signal-no-marker-frame");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({
      imported: {
        source: "veil",
        retrofit: true,
        original_last_house_seq: 4,
        slices: [{ retrofit: true, house_first_seq: 5, house_last_seq: 10, stream: "signal:group:x", exported_t: "2026-09-20T00:31:46.274Z" }],
      },
    }),
  );
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ sessions: [] }));
  // no frame here carries note:"import-slice" at all — an anomaly.
  writeFrames(runDir, [
    { seq: 4, t: "2026-09-19T20:00:00.000Z", type: "rested" },
    { seq: 5, t: "2026-06-16T23:50:35.103Z", type: "speech", by: "sam" },
    { seq: 10, t: "2026-06-16T23:50:35.103Z", type: "rested" },
  ]);
  const plan = planRoom(runDir);
  assert.deepEqual(plan.markerGrounded, [false]);
  // falls back to the recorded [5, 10] verbatim: seq 5 and seq 10 qualify,
  // seq 4 (outside the range) does not.
  assert.equal(plan.stamped, 2);
});

test("stampImported: fallback criterion (no slices[] marker, only original_last_house_seq) — old t AND seq above the pre-retrofit end", () => {
  const runs = sandbox();
  const runDir = join(runs, "room-signal-legacy");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({
      imported: { source: "veil", stream: "signal:group:legacy", platform: "signal", retrofit: true, original_last_house_seq: 12.5 },
    }),
  );
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "room-signal-legacy", sessions: [] }));
  writeFrames(runDir, [
    { seq: 5, t: "2026-09-19T20:00:00.000Z", type: "speech", by: "sam" }, // pre-retrofit live, old t, seq BELOW the pre-retrofit end
    { seq: 13.5, t: "2026-06-16T23:50:35.103Z", type: "speech", by: "sam" }, // the retrofit's own: old t, seq above 12.5
    { seq: 21, t: "2026-09-20T00:49:20.600Z", type: "speech", by: "sam" }, // post-retrofit live: NEW t, seq above 12.5
  ]);

  const info = classifyRoom(runDir);
  assert.equal(info.hasMarker, false);
  assert.equal(info.originalLastHouseSeq, 12.5);

  const res = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(res.totals.framesStamped, 1);
  const frames = readFrames(runDir);
  assert.equal(frames.find((f) => f.seq === 5).origin, undefined);
  assert.equal(frames.find((f) => f.seq === 13.5).origin, "import");
  assert.equal(frames.find((f) => f.seq === 21).origin, undefined, "new t, even above the pre-retrofit seq, is not the retrofit's own");
});

test("stampImported: retrofit true, no slices[] marker, no original_last_house_seq -> retrofit-unresolvable, left untouched", () => {
  const runs = sandbox();
  const runDir = join(runs, "room-signal-unresolvable");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify({ imported: { source: "veil", retrofit: true } }));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ sessions: [] }));
  writeFrames(runDir, [{ seq: 0, t: "2026-01-01T00:00:00Z", type: "speech", by: "sam" }]);
  const before = rawFrames(runDir);

  const res = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(res.totals.roomsSkippedUnresolvable, 1);
  assert.equal(rawFrames(runDir), before);
});

test("stampImported: frames already carrying origin are left alone (a future, already-stamped import mixed with legacy unstamped ones)", () => {
  const runs = sandbox();
  const runDir = makeWholesaleRoom(runs, "room-discord-partial", [
    { seq: 0, t: "2026-01-01T00:00:00Z", type: "room.mounted", origin: "import" },
    { seq: 1, t: "2026-01-01T00:00:01Z", type: "message", by: "x" },
  ]);
  const res = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(res.totals.framesAlreadyStamped, 1);
  assert.equal(res.totals.framesStamped, 1);
  const frames = readFrames(runDir);
  assert.equal(frames[0].origin, "import");
  assert.equal(frames[1].origin, "import");
});

test("stampImported: a not-imported (pure live) room is never opened for writing at all", () => {
  const runs = sandbox();
  const runDir = join(runs, "room-live-only");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify({ room: { platform: "discord" } }));
  writeFrames(runDir, [{ seq: 0, t: "2026-01-01T00:00:00Z", type: "room.mounted" }]);
  const before = rawFrames(runDir);
  const res = stampImported({ runsDir: runs, dryRun: false });
  assert.equal(res.totals.roomsSkippedNotImported, 1);
  assert.equal(rawFrames(runDir), before);
});

// ---------- planRoom: no frames.jsonl at all ----------

test("planRoom: a room directory with no frames.jsonl returns null (nothing to plan)", () => {
  const runs = sandbox();
  const runDir = join(runs, "empty-room");
  mkdirSync(runDir, { recursive: true });
  assert.equal(planRoom(runDir), null);
});

// ---------- CLI end to end ----------

test("cli.mjs --stamp-imported: dry-run vs --real, and the mutual-exclusion gate", () => {
  const runs = sandbox();
  makeWholesaleRoom(runs, "room-discord-cli", [
    { seq: 0, t: "2026-01-01T00:00:00Z", type: "room.mounted" },
    { seq: 1, t: "2026-01-01T00:00:01Z", type: "rested", turns: 0, reaches: 0 },
  ]);

  const neither = spawnSync(process.execPath, [CLI, "--stamp-imported", "--runs", runs]);
  assert.notEqual(neither.status, 0, "neither --dry-run nor --real must refuse");

  const both = spawnSync(process.execPath, [CLI, "--stamp-imported", "--runs", runs, "--dry-run", "--real"]);
  assert.notEqual(both.status, 0, "both flags together must also refuse");

  const dry = spawnSync(process.execPath, [CLI, "--stamp-imported", "--runs", runs, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr?.toString());
  assert.match(dry.stderr.toString(), /dry-run — nothing written/);
  assert.match(dry.stderr.toString(), /frames stamped=2/);

  const real = spawnSync(process.execPath, [CLI, "--stamp-imported", "--runs", runs, "--real"]);
  assert.equal(real.status, 0, real.stderr?.toString());
  assert.match(real.stderr.toString(), /frames stamped=2/);
  const frames = readFrames(join(runs, "room-discord-cli"));
  assert.ok(frames.every((f) => f.origin === "import"));

  const again = spawnSync(process.execPath, [CLI, "--stamp-imported", "--runs", runs, "--dry-run"]);
  assert.match(again.stderr.toString(), /frames stamped=0/, "a re-run's own dry-run reports 0 to stamp");
});

#!/usr/bin/env node
// @ts-check
/* connectome-history-import/src/cli.mjs — the fleet's VEIL archive -> house
 * records -> the beings' lives. The one sanctioned way in.
 *
 *   node connectome-history-import/src/cli.mjs --state <veil-state dir>
 *     --out <runs dir> --private <private dir> --blobs <blob root>
 *     [--streams <glob>] [--limit N] [--dry-run] [--report <path>]
 *     [--no-lives] [--scrub-names] [--real] [--beings <path>]
 *
 * `--beings <path>`: the known-beings set a VEIL speech facet's `agentName`
 * must be in to still mint a being — `bot-runtime/config.json`'s own
 * `{"bots":[{"name":…}]}` shape, or a plain `["name", …]`. Absent, every
 * speech author is a being (unchanged default) and the report carries a
 * one-line warning; a speech author outside the set is a HUMAN whose
 * typed messages were recorded as speech facets (a substream/workflow
 * stream bug — beings.mjs) — re-classed to a `message` frame, never a
 * being, no life seeded (records.mjs's `buildRoom`).
 *
 * `--real` is required to write into the house's own real runs/private/
 * blob roots (a deployment's connectome-house/runs, connectome-house/
 * private, its blob root): without it, every output root must be
 * somewhere else — a sandbox. `HOUSE_IDENTITY_SALT` must be set
 * (connectome-house's identity-map.mjs refuses an unsalted pseudonym).
 * Idempotent per stream: a room already in `--out` with the same
 * `imported.last_seq` is skipped; one with a different last_seq is
 * reported and left alone — appending a later slice is `slice.mjs`'s own
 * job, not this CLI's (docs/harness-port/04-history-restore.md §6).
 * `--dry-run` reads everything and writes nothing, printing counts per
 * stream and, with `--report`, the same markdown report a real run writes.
 *
 * IMPORT-ORDER DISCIPLINE (do not "simplify" by hoisting these to static
 * imports): connectome-house's `serve-paths.mjs` freezes its RUNS/
 * PRIVATE_DIR constants — and, via `house-config.mjs`'s own memoized
 * `houseConfig()`, EVERY later importer's view of them too — the first
 * time ANYTHING imports it, directly or transitively (`write.mjs` ->
 * `blob-root.mjs` -> `serve-paths.mjs`; `identity-map.mjs` ->
 * `serve-paths.mjs` directly; `serve-room-open.mjs` -> `resident-life.mjs`
 * -> `serve-paths.mjs`). Every one of those must be `await import(...)`ed
 * ONLY after this file has set `HOUSE_RUNS_DIR`/`HOUSE_PRIVATE_DIR` on
 * `process.env` below. `records.mjs`/`streams.mjs`/`facets.mjs`/
 * `buckets.mjs`/`report.mjs`/`lives.mjs` touch no house module at all —
 * those alone are safe to import statically, at the top, as below.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyStats, listBuckets, streamFrames } from "./buckets.mjs";
import { recordsOf } from "./facets.mjs";
import { countGroup, groupStreams } from "./streams.mjs";
import { buildRoom, forkSeqOf, roomId } from "./records.mjs";
import { reportMarkdown } from "./report.mjs";
import { roomBeings, seedLives } from "./lives.mjs";
import { isKnownBeing, loadBeings } from "./beings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const HOUSE_ROOT = resolve(PACKAGE_ROOT, "..", "connectome-house");
const REAL = {
  runs: resolve(HOUSE_ROOT, "runs"),
  private: resolve(HOUSE_ROOT, "private"),
  blobs: resolve(HOUSE_ROOT, "blobs"),
};

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] != null ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

function usage() {
  console.error(
    "usage: node connectome-history-import/src/cli.mjs --state <dir> --out <runs-dir> --private <dir> --blobs <dir> " +
      "[--streams <glob>] [--limit N] [--dry-run] [--report <path>] [--no-lives] [--scrub-names] [--real] [--beings <path>]",
  );
}

/** a `*`-only glob over raw stream ids */
function globRe(glob) {
  return new RegExp(
    `^${String(glob)
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

/** rooms already under `runsDir`: stream key -> {id, last_seq} */
function existingRooms(runsDir) {
  const out = new Map();
  if (!existsSync(runsDir)) return out;
  for (const d of readdirSync(runsDir)) {
    try {
      const cls = JSON.parse(readFileSync(join(runsDir, d, "class.json"), "utf8"));
      // a place (class.json.room) — inlined rather than importing
      // connectome-house's room-policy.mjs, which would drag serve-paths.mjs's
      // env-read RUNS/PRIVATE_DIR in before this CLI sets them (see the
      // module header's import-order discipline).
      if (cls.room && typeof cls.room === "object" && cls.room.stream)
        out.set(cls.room.stream, { id: d, last_seq: cls.imported?.last_seq ?? null });
    } catch {
      /* not a room */
    }
  }
  return out;
}

async function main() {
  const stateDir = arg("--state");
  const outDir = arg("--out");
  const privateDir = arg("--private");
  const blobDir = arg("--blobs");
  const dryRun = has("--dry-run");
  if (!stateDir || !outDir || !privateDir || !blobDir) {
    usage();
    process.exitCode = 1;
    return;
  }
  const beingsPath = arg("--beings") ? resolve(arg("--beings")) : null;
  const knownBeings = loadBeings(beingsPath);
  if (!beingsPath)
    console.error(
      "[history-import] WARNING: no --beings file given — every speech author is treated " +
        "as a being (default, unchanged); a substream/workflow stream recording a human's " +
        "typed messages as speech facets would mint a being out of a person.",
    );
  const roots = { runs: resolve(outDir), private: resolve(privateDir), blobs: resolve(blobDir) };
  const touchesReal = Object.entries(roots)
    .filter(([k, v]) => v === REAL[k])
    .map(([k]) => k);
  if (touchesReal.length && !has("--real")) {
    console.error(
      `refusing: --${touchesReal.join("/--")} resolve(s) to the house's REAL ${touchesReal.join(", ")} root ` +
        "and --real was not passed. Point every root at a sandbox, or pass --real to confirm.",
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.HOUSE_IDENTITY_SALT && !dryRun) {
    console.error(
      "refusing: HOUSE_IDENTITY_SALT is not set — a platform id must never become an unsalted pseudonym.",
    );
    process.exitCode = 1;
    return;
  }
  // connectome-house's own path modules read these at import time — set
  // before any dynamic import of a house module below (module header).
  process.env.HOUSE_RUNS_DIR = roots.runs;
  process.env.HOUSE_PRIVATE_DIR = roots.private;
  process.env.HOUSE_BLOB_ROOT = roots.blobs;
  const t0 = Date.now();
  const log = (s) => console.error(s);

  // 1. read every frame once
  const stats = emptyStats();
  const buckets = listBuckets(resolve(stateDir));
  log(`[history-import] ${buckets.length} buckets under ${stateDir}`);
  const grouper = groupStreams();
  for (const { frame, bucket } of streamFrames(buckets, stats))
    grouper.add(recordsOf(frame), bucket.hash);
  const { groups, delivered, mentions, orphanMarks } = grouper.finish();
  log(
    `[history-import] read ${stats.frames_read} frames (${stats.frames_unique} unique, ${stats.duplicates} duplicates) ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${groups.size} streams, ${orphanMarks} marks on facets outside the kept history`,
  );

  // 2. which streams
  const re = arg("--streams") ? globRe(arg("--streams")) : null;
  let selected = [...groups.values()].filter(
    (g) => g.items.length > 0 && (!re || re.test(g.stream)),
  );
  selected.sort((a, b) => ((a.firstT ?? "") < (b.firstT ?? "") ? -1 : 1));
  const limit = Number(arg("--limit", "0"));
  if (limit > 0) selected = selected.slice(0, limit);
  // parents before their substreams (a child needs its parent's seq map)
  const chosen = new Set(selected.map((g) => g.stream));
  const ordered = [];
  const placed = new Set();
  const place = (g) => {
    if (placed.has(g.stream)) return;
    placed.add(g.stream); // before the parent hop: a self/cyclic parent must not recurse
    if (g.parent && g.parent !== g.stream && chosen.has(g.parent) && !placed.has(g.parent))
      place(groups.get(g.parent));
    ordered.push(g);
  };
  for (const g of selected) place(g);

  const counts = ordered.map((g) => ({
    stream: g.stream,
    platform: g.platform,
    parent: g.parent,
    ...countGroup(g),
  }));
  if (dryRun) {
    for (const c of counts)
      log(
        `  ${c.platform.padEnd(9)} frames=${c.frames} messages=${c.messages} speech=${c.speech} bots=${c.bots} humans=${c.humans} ` +
          `attachments=${c.attachments} edits=${c.edits} deletions=${c.deletions} redactions=${c.redactions}${c.parent ? " (substream)" : ""}`,
      );
    log(`[history-import] dry run: ${ordered.length} streams would be written under ${roots.runs}`);
    if (arg("--report"))
      writeReport(arg("--report"), {
        stats,
        counts,
        written: [],
        lives: [],
        skipped: [],
        t0,
        roots,
        dryRun,
        beingsFile: beingsPath,
        reclassed: [],
      });
    return;
  }

  // 3. write — every house module below is dynamically imported (see the
  // module header's import-order discipline)
  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("./identity.mjs");
  const { writeRoom, markBranchOnParent } = await import("./write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");
  const identity = makeIdentity({ identityFor, phoneId, scrubNames: has("--scrub-names") });
  // every name -> handle BEFORE any room is built, so an @-mention of
  // someone who speaks later (or never) still scrubs to a handle. Every
  // ordinary message's human, in its own pass, BEFORE any speech facet is
  // resolved: a speech author re-classed as human (beings.mjs) must find
  // their real identity already registered, whichever stream holds which,
  // never depend on stream processing order for the "same handle" match.
  for (const m of mentions.values())
    identity.human({ platform: m.platform, id: m.id, display: m.username });
  for (const g of ordered)
    for (const it of g.items)
      if (it.kind === "message" && it.authorId)
        identity.human({ platform: it.platform, id: it.authorId, display: it.authorName });
  for (const g of ordered)
    for (const it of g.items)
      if (it.kind === "speech") {
        if (isKnownBeing(knownBeings, it.agentName)) identity.bot(it.agentName);
        else identity.humanFromSpeechAuthor(g.platform, it.agentName);
      }
  // a bot's Signal number, from every stream where exactly one bot spoke —
  // learned for ALL streams first, so a DM's key is the same whatever
  // order the rooms are built in (and the same on a re-run)
  for (const g of groups.values()) {
    const speakers = new Set(
      g.items.filter((it) => it.kind === "speech").map((it) => it.agentName),
    );
    if (speakers.size !== 1) continue;
    for (const it of g.items)
      if (it.kind === "message" && it.botPhone)
        identity.learnBotPhone(it.botPhone, [...speakers][0]);
  }
  const houseId = process.env.HOUSE_ID || "local";
  const exportedT = new Date().toISOString();
  mkdirSync(roots.runs, { recursive: true });
  const already = existingRooms(roots.runs);
  const built = new Map(); // raw stream -> {id, veilToHouse}
  const written = [];
  const skipped = [];
  for (const g of ordered) {
    const key = identity.streamKey(g.stream);
    const prior = already.get(key);
    if (prior) {
      skipped.push({
        stream: key,
        id: prior.id,
        why:
          prior.last_seq === g.lastSeq
            ? "already imported"
            : `on disk through seq ${prior.last_seq}, source now at ${g.lastSeq} — not appended (see slice.mjs)`,
      });
      continue;
    }
    const parent = g.parent ? built.get(g.parent) : null;
    const forkedFrom = parent
      ? { run: parent.id, seq: forkSeqOf(parent.veilToHouse, g.firstSeq) }
      : null;
    const id = roomId({ platform: g.platform, key, slug8: roomSlug(key), firstT: g.firstT });
    const room = buildRoom({
      group: g,
      key,
      id,
      identity,
      delivered,
      forkedFrom,
      houseId,
      exportedT,
      substrate: "chronicle",
      knownBeings,
    });
    const res = await writeRoom({ runsDir: roots.runs, stateDir: resolve(stateDir), room });
    if (forkedFrom) markBranchOnParent(roots.runs, forkedFrom.run, id);
    built.set(g.stream, { id, veilToHouse: room.veilToHouse });
    written.push({
      id,
      platform: g.platform,
      frames: res.frames,
      blobs: res.blobs,
      beings: room.cls.beings,
      substrate: res.substrate,
      ...room.stats,
      counts: countGroup(g),
      forked: !!forkedFrom,
    });
    log(
      `  wrote ${id} (${res.frames} frames, ${room.cls.beings.length} beings, blobs ${JSON.stringify(res.blobs)})`,
    );
  }

  // 4. lives
  let lives = [];
  // every imported room under --out, not only this run's: appendPeriod is
  // idempotent per (run, handle), so a re-run only appends what a prior
  // run never reached (a crash, a skipped stream)
  const importedRooms = [
    ...written.map((w) => ({ id: w.id, beings: w.beings })),
    ...skipped.map((s) => ({ id: s.id, beings: roomBeings(join(roots.runs, s.id)) })),
  ];
  if (!has("--no-lives") && importedRooms.length) {
    const lifeMod = await import("connectome-house/src/resident-life.mjs");
    const { testamentFor } = await import("connectome-house/src/testaments.mjs");
    const voiceFor = async (handle) => {
      const speaksFor = has("--real") ? testamentFor(handle)?.covenant?.speaks_for : null;
      const voice = typeof speaksFor === "string" ? speaksFor : "mock";
      return {
        speaksFor: voice,
        covenant: {},
        membrane: await lifeMod.membraneForSpeaksFor(voice),
      };
    };
    lives = await seedLives({
      runsDir: roots.runs,
      privateRoot: roots.private,
      rooms: importedRooms,
      voiceFor,
      life: lifeMod,
      log,
    });
    lifeMod.closeAllLives();
  }
  // speech authors re-classed as humans, summed by name across every room
  const reclassed = new Map(); // agentName -> {handle, count}
  for (const w of written)
    for (const r of w.reclassed ?? []) {
      const cur = reclassed.get(r.name) ?? { handle: r.handle, count: 0 };
      cur.count += r.count;
      reclassed.set(r.name, cur);
    }
  const report = {
    stats,
    counts,
    written,
    lives,
    skipped,
    t0,
    roots,
    dryRun: false,
    collisions: identity.collisions,
    humans: identity.humansSeen(),
    bots: identity.bots().size,
    beingsFile: beingsPath,
    reclassed: [...reclassed.entries()].map(([name, r]) => ({
      name,
      handle: r.handle,
      count: r.count,
    })),
  };
  if (arg("--report")) writeReport(arg("--report"), report);
  log(
    `[history-import] done: ${written.length} rooms written, ${skipped.length} skipped, ${lives.length} lives seeded, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

function writeReport(path, report) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), reportMarkdown(report));
  console.error(`[history-import] report: ${path}`);
}

main().catch((e) => {
  console.error(`history-import: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});

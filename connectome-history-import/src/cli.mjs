#!/usr/bin/env node
// @ts-check
/* connectome-history-import/src/cli.mjs — the fleet's VEIL archive -> house
 * records -> the beings' lives. The one sanctioned way in.
 *
 *   node connectome-history-import/src/cli.mjs --state <veil-state dir>
 *     --out <runs dir> --private <private dir> --blobs <blob root>
 *     [--streams <glob>] [--limit N] [--dry-run] [--report <path>]
 *     [--no-lives] [--scrub-names] [--real] [--beings <path>]
 *     [--retrofit] [--retrofit-only] [--rooms <id,id>]
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
 * `imported.last_seq` is skipped; one with a different last_seq (or with
 * NO `imported` field at all — a room the HOUSE itself minted live, never
 * touched by this importer before) is reported and left alone unless
 * `--retrofit`/`--retrofit-only` is given, in which case `retrofit.mjs`
 * appends it via `slice.mjs`'s `sliceRoom` right after this same sweep
 * (docs/harness-port/04-history-restore.md §6; the retrofit case is
 * `docs/harness-port/21-restore-rehearsal.md` §6).
 * `--dry-run` reads everything and writes nothing, printing counts per
 * stream and, with `--report`, the same markdown report a real run writes.
 *
 * "already on disk" is decided the SAME way the live house decides it —
 * `connectome-house/src/room-index.mjs`'s `findRoom({platform, stream})`
 * (dynamically imported below, same import-order discipline) — never a
 * bespoke re-scan of `--out` with its own notion of what a stream's
 * canonical key is. This matters beyond tidiness: `findRoom` carries the
 * house's own `canonicalStream` rule (stream-key.mjs) AND its raw-stream
 * back-compat fallback for a room minted before that rule existed; a
 * second, independently-written scan here could disagree with it on
 * exactly the case (a Signal DM under more than one house number) where
 * disagreeing means minting a duplicate room for a stream the house
 * already has open — the one failure this importer must never cause.
 *
 * IMPORT-ORDER DISCIPLINE (do not "simplify" by hoisting these to static
 * imports): connectome-house's `serve-paths.mjs` freezes its RUNS/
 * PRIVATE_DIR constants — and, via `house-config.mjs`'s own memoized
 * `houseConfig()`, EVERY later importer's view of them too — the first
 * time ANYTHING imports it, directly or transitively (`write.mjs` ->
 * `blob-root.mjs` -> `serve-paths.mjs`; `identity-map.mjs` ->
 * `serve-paths.mjs` directly; `serve-room-open.mjs` -> `resident-life.mjs`
 * -> `serve-paths.mjs`; `room-index.mjs` -> `serve-paths.mjs` directly
 * too). Every one of those must be `await import(...)`ed ONLY after this
 * file has set `HOUSE_RUNS_DIR`/`HOUSE_PRIVATE_DIR` on `process.env`
 * below. `records.mjs`/`streams.mjs`/`facets.mjs`/`buckets.mjs`/
 * `report.mjs`/`lives.mjs` touch no house module at all — those alone are
 * safe to import statically, at the top, as below.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyStats, listBuckets, streamFrames } from "./buckets.mjs";
import { recordsOf } from "./facets.mjs";
import { countGroup, groupStreams } from "./streams.mjs";
import { buildRoom, forkSeqOf, roomId } from "./records.mjs";
import { reportMarkdown } from "./report.mjs";
import { roomBeings, seedLives } from "./lives.mjs";
import { classifySpeechAuthor, loadBeings, summarizeSpeechClassification } from "./beings.mjs";

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
      "[--streams <glob>] [--limit N] [--dry-run] [--report <path>] [--no-lives] [--scrub-names] [--real] [--beings <path>] " +
      "[--retrofit] [--retrofit-only] [--rooms <id,id>]\n" +
      "   or: node connectome-history-import/src/cli.mjs --stamp-imported --runs <dir> (--dry-run|--real)",
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

/** `--stamp-imported --runs <dir> (--dry-run|--real)` (docs/harness-port/
 * 26-retro-stamp.md): retroactively stamps `origin: "import"`
 * (25-outbound-guardrail.md rule 3) onto frames this package wrote before
 * that marker existed — a standalone maintenance pass over an already-
 * written `--runs` dir, touching no VEIL state and no identity map, so it
 * takes none of the ordinary sweep's own flags. Exactly one of
 * `--dry-run`/`--real` is required, same spirit as the ordinary sweep's
 * own `--real` gate: a bare invocation must never silently rewrite a real
 * runs dir, and a real rewrite must never be an accident of a missing
 * flag either way. See `stamp-imported.mjs`'s own header for the full
 * per-room classification this delegates to.
 * @returns {Promise<void>} */
async function runStampImported() {
  const runsDir = arg("--runs");
  const dryRun = has("--dry-run");
  const real = has("--real");
  if (!runsDir || dryRun === real) {
    usage();
    process.exitCode = 1;
    return;
  }
  const { stampImported } = await import("./stamp-imported.mjs");
  const { totals, perRoom } = stampImported({ runsDir: resolve(runsDir), dryRun });
  for (const r of perRoom) {
    if ((r.stamped ?? 0) > 0 || r.kind === "wholesale-mixed" || r.kind === "retrofit-unresolvable")
      console.error(
        `  ${r.id}: ${r.kind} stamped=${r.stamped ?? 0} alreadyStamped=${r.alreadyStamped ?? 0} ` +
          `outOfScope=${r.outOfScope ?? 0}${r.usedFallback ? " (fallback criterion)" : ""}${r.warning ? ` — ${r.warning}` : ""}`,
      );
  }
  console.error(
    `[history-import] stamp-imported ${dryRun ? "(dry-run — nothing written)" : "(real)"}: ` +
      `rooms touched=${totals.roomsTouched}, frames stamped=${totals.framesStamped}, ` +
      `already stamped=${totals.framesAlreadyStamped}, out of scope=${totals.framesOutOfScope}, ` +
      `parse errors=${totals.parseErrors}, not-imported rooms skipped=${totals.roomsSkippedNotImported}, ` +
      `wholesale-mixed skipped=${totals.roomsSkippedMixed}, retrofit-unresolvable skipped=${totals.roomsSkippedUnresolvable}`,
  );
}

async function main() {
  if (has("--stamp-imported")) return runStampImported();
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
  const { retrofitFlags, applyRetrofit, previewRetrofit } = await import("./retrofit.mjs");
  const { retrofit, retrofitOnly, namedRooms } = retrofitFlags(argv);

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

  // countGroup applies the SAME beings classification a real write does
  // (records.mjs's buildRoom), so a dry run's counts already match it.
  const counts = ordered.map((g) => ({
    stream: g.stream,
    platform: g.platform,
    parent: g.parent,
    ...countGroup(g, knownBeings),
  }));
  const houseId = process.env.HOUSE_ID || "local";
  const exportedT = new Date().toISOString();
  if (dryRun) {
    if (retrofit) {
      await previewRetrofit({
        ordered, groups, namedRooms, runsDir: roots.runs, stateDir: resolve(stateDir),
        delivered, houseId, exportedT, knownBeings, log,
        reportPath: arg("--report"), stats, t0, roots, beingsFile: beingsPath,
      });
      return;
    }
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
        // no identity map exists yet in a dry run (no salt is required) —
        // named by agentName only, no handle to attribute to yet.
        ...summarizeSpeechClassification(counts),
      });
    return;
  }

  // 3. write — every house module below is dynamically imported (see the
  // module header's import-order discipline)
  const { identityFor, phoneId } = await import("connectome-house/src/identity-map.mjs");
  const { makeIdentity } = await import("./identity.mjs");
  const { writeRoom, markBranchOnParent } = await import("./write.mjs");
  const { roomSlug } = await import("connectome-house/src/serve-room-open.mjs");
  // the house's own {platform, stream} -> room lookup (module header) —
  // never a bespoke re-scan of --out.
  const { findRoom } = await import("connectome-house/src/room-index.mjs");
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
    for (const it of g.items) {
      if (it.kind !== "speech") continue;
      const cls = classifySpeechAuthor(knownBeings, it.agentName);
      if (cls.kind === "being") identity.bot(cls.canonical);
      else if (cls.kind === "human") identity.humanFromSpeechAuthor(g.platform, it.agentName);
      // "system" (beings.mjs): never registered as an identity at all
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
  mkdirSync(roots.runs, { recursive: true });
  const built = new Map(); // raw stream -> {id, veilToHouse}
  const written = [];
  const skipped = [];
  for (const g of ordered) {
    const key = identity.streamKey(g.stream);
    // the house's own lookup, given the RAW stream (findRoom canonicalizes
    // it itself, plus its own raw-stream back-compat fallback) — this can
    // legitimately find a room this importer never wrote: one the house's
    // live seat minted itself, with no `imported` field at all.
    const existing = findRoom({ platform: g.platform, stream: g.stream });
    if (existing) {
      let priorLastSeq = null;
      try {
        const priorCls = JSON.parse(readFileSync(join(roots.runs, existing.id, "class.json"), "utf8"));
        priorLastSeq = priorCls.imported?.last_seq ?? null;
      } catch {
        /* unreadable class.json — treated as unknown below, never fatal */
      }
      skipped.push({
        stream: key,
        id: existing.id,
        why:
          priorLastSeq === g.lastSeq
            ? "already imported"
            : priorLastSeq == null
              ? "already on disk as a room this importer never wrote (a live-minted room, or an unreadable class.json) — not appended; see slice.mjs for the retrofit append"
              : `on disk through seq ${priorLastSeq}, source now at ${g.lastSeq} — not appended (see slice.mjs)`,
      });
      continue;
    }
    if (retrofitOnly) continue; // retrofit-only: never mints a new room
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
      counts: countGroup(g, knownBeings),
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

  // 5. retrofit, as a flag (21-restore-rehearsal.md §6) — the same sweep,
  // group and identity above, appending what step 3 above just skipped.
  const retrofitted = retrofit
    ? await applyRetrofit({
        ordered, groups, namedRooms, runsDir: roots.runs, stateDir: resolve(stateDir),
        identity, delivered, houseId, exportedT, knownBeings, log,
      })
    : null;

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
    retrofitted,
    // speech authors re-classed as humans / aliased to a being / system
    // notices, summed by name across every room
    ...summarizeSpeechClassification(written, { withHandle: true }),
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

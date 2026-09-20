// @ts-check
/* connectome-history-import/src/stamp-imported.mjs — retroactively stamps
 * `origin: "import"` (docs/harness-port/25-outbound-guardrail.md, rule 3)
 * onto frames that this package's own `write.mjs`/`slice.mjs` wrote
 * BEFORE that marker existed. Born 2026-09-20 (docs/harness-port/
 * 26-retro-stamp.md): the night's full restore (`restore-all.md`, 281
 * rooms minted wholesale) and its retrofits (`retrofit-all.md`, rooms
 * `3c51ff61…`/`bab97539…`/`411d697c…` — VEIL history appended UNDER
 * already-live conversation) all ran against the pre-rule-3 code, so
 * every frame they wrote is unmarked on disk today even though the
 * outbound guard (`mcpl/outbound-guard.mjs`'s `isImportOrigin`) now
 * refuses any frame that carries the marker.
 *
 * Per-room classification, read from the room's own `class.json`/
 * `run.json` — never re-derived from a report or a timestamp guess where
 * a reliable structural marker exists on disk:
 *
 *   - no `class.json.imported` at all: a room this importer never wrote,
 *     live-minted end to end. NEVER touched.
 *   - `imported` present, `imported.retrofit` NOT `true`: a WHOLESALE
 *     import — the room did not exist before this importer minted it, so
 *     (barring live activity afterward, checked below) every one of its
 *     frames is import content. Every frame missing `origin` is stamped.
 *   - `imported.retrofit === true`: a RETROFIT — VEIL history appended
 *     underneath a room the house's own live seat had already been
 *     writing to. Only the frames the retrofit itself appended may be
 *     stamped; the room's earlier live frames (before the retrofit) and
 *     any later live frames (after it) must never be touched.
 *
 * The retrofit marker, and a real bug in its own recorded bounds
 * -----------------------------------------------------------------
 * `slice.mjs`'s own `sliceRoom` (the K4 late-slice append) records, per
 * slice, in `class.json.imported.slices[]`, a `{retrofit: true,
 * house_first_seq, house_last_seq, stream, exported_t}` entry meant to be
 * the exact, inclusive house-frame-seq range one `appendSlice` call wrote
 * (the leading `note:"import-slice"` marker frame through the trailing
 * closing frame). Checked against tonight's own three retrofitted rooms,
 * these recorded bounds are OFF by a small constant per room — `slice.mjs`
 * predicts its own `startSeq` from `lastFrameInfo(...).seq + 2` assuming
 * the underlying trace assigns seq by simple integer succession from
 * there, but a trace RESUMING a room whose last frame carries a
 * fractional seq (`room-tails.mjs`/`frames-io.mjs`'s own bisection scheme
 * for a house-authored insert into a not-currently-open room — the same
 * scheme `write.mjs`'s `markBranchOnParent` uses) actually anchors the
 * next integer at `Math.ceil(lastSeq)`, not at the caller's own predicted
 * value — e.g. room `bab97539…`: `original_last_house_seq: 4.998046875`,
 * predicted `house_first_seq: 5.998046875`, ACTUAL on-disk marker frame
 * at `seq: 5` (`Math.ceil(4.998046875)`) — a difference of 0.998046875,
 * and the room's OWN recorded `house_last_seq` carries the identical
 * offset (verified: the recorded SPAN, `house_last_seq - house_first_seq`,
 * matches the real span between the actual marker frame and the actual
 * closing frame exactly, in all three of tonight's retrofitted rooms —
 * only the absolute anchor is wrong, never the span).
 *
 * Trusting the recorded bounds verbatim would silently miss the marker
 * frame itself (and shift the whole window) for every retrofit whose
 * pre-retrofit last frame had a fractional seq — which was true of all
 * three rooms tonight. This module never trusts the absolute bounds: for
 * each `slices[]` entry, it SEARCHES `frames.jsonl` for the actual
 * `type:"house", note:"import-slice"` marker frame matching that slice's
 * own `stream`/`exported_t` (both recorded in the slice entry, and both
 * independent of the seq-numbering bug above), takes that frame's REAL
 * `seq` as the range's true start, and adds the recorded (and verified
 * trustworthy) SPAN to get the true end. Only when no such marker frame
 * can be found on disk (an anomaly this dataset never hits) does it fall
 * back to the recorded bounds verbatim, flagged `markerGrounded: false`
 * in the room's own plan for the report to name honestly.
 *
 * Fallback for a retrofit with NO usable `slices[]` entry at all (neither
 * shape): a frame qualifies when its OWN `t` predates the restore's own
 * start (`RESTORE_START`, 2026-09-20T00:29Z) AND its `seq` is above the
 * room's own recorded `imported.original_last_house_seq`. Neither bound
 * alone is enough (an old `t` is also true of the room's genuine
 * pre-retrofit history; a higher `seq` alone is also true of ordinary
 * later live activity) — both together name exactly the shape a
 * retrofit's own append has and nothing else does.
 *
 * A room with NEITHER a slices[] marker NOR `original_last_house_seq` is
 * left untouched and reported `retrofit-unresolvable` — fail closed,
 * matching write.mjs's own header ("an importer that fails open would
 * lose that history's only remaining honest witness").
 *
 * A WHOLESALE room additionally has its own safety check before the
 * "every frame" rule applies: `run.json.sessions` must contain ONLY
 * `imported: true` entries. A room where the live house continued after
 * the restore would show an ADDITIONAL, non-imported session there — such
 * a room is reported `wholesale-mixed` and left entirely untouched (no
 * partial/heuristic seq-slicing attempted for this shape; none of
 * tonight's 281 wholesale rooms hit this case, verified in `26-retro-
 * stamp.md`'s own report, but the check stays as a standing guard).
 *
 * Write discipline: every rewritten `frames.jsonl` is written to a tmp
 * file in the SAME directory, then renamed over the original — the one
 * in-place write to the runs volume this task's own brief allows, and
 * only when `stampImported` is called with `dryRun: false`. A stamped
 * line is otherwise byte-exact: `origin` is appended as the object's LAST
 * key (a plain text-level `}` -> `,"origin":"import"}` splice on the raw
 * line, never a JSON.parse+stringify round-trip, which could reorder keys
 * or renormalize a number's own text) — every other line, and everything
 * on a stamped line before its closing brace, is untouched.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** the restore's own reported start (`restore-all.md`'s header,
 * `docs/harness-port/24-incident-2026-09-20-cascade.md`'s timeline) —
 * used only by the fallback criterion, when no `slices[]` marker exists. */
export const RESTORE_START = "2026-09-20T00:29:00.000Z";
const RESTORE_START_MS = Date.parse(RESTORE_START);

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // a torn/unreadable file is never fatal — treated as absent
  }
}

/** @param {string} runDir
 * @returns {{kind: "not-imported"}
 *   | {kind: "wholesale"}
 *   | {kind: "retrofit", slices: object[], hasMarker: boolean, originalLastHouseSeq: number|null}} */
export function classifyRoom(runDir) {
  const cls = readJsonSafe(join(runDir, "class.json"));
  const imported = cls?.imported && typeof cls.imported === "object" ? cls.imported : null;
  if (!imported) return { kind: "not-imported" };
  if (imported.retrofit === true) {
    const allSlices = Array.isArray(imported.slices) ? imported.slices : [];
    const slices = allSlices.filter(
      (s) =>
        s &&
        s.retrofit === true &&
        typeof s.house_first_seq === "number" &&
        typeof s.house_last_seq === "number",
    );
    return {
      kind: "retrofit",
      slices,
      hasMarker: slices.length > 0,
      originalLastHouseSeq:
        typeof imported.original_last_house_seq === "number" ? imported.original_last_house_seq : null,
    };
  }
  return { kind: "wholesale" };
}

/** a wholesale room is safe to blanket-stamp only when `run.json`'s own
 * session history shows NOTHING but imported sessions — any live session
 * (a house-authored turn after the restore) means this room needs the
 * same care a retrofit gets, not this module's job today (see header).
 * @param {string} runDir @returns {boolean} */
function wholesaleIsSafe(runDir) {
  const run = readJsonSafe(join(runDir, "run.json"));
  const sessions = Array.isArray(run?.sessions) ? run.sessions : null;
  return !!sessions && sessions.length > 0 && sessions.every((s) => s && s.imported === true);
}

function inAnyRange(seq, ranges) {
  return ranges.some(([lo, hi]) => seq >= lo && seq <= hi);
}

/** appends `,"origin":"import"` immediately before a JSONL line's own
 * closing `}` — never a parse+stringify round-trip (see module header).
 * @param {string} line @returns {string} */
export function stampLine(line) {
  return line.replace(/\}\s*$/, ',"origin":"import"}');
}

/** grounds each retrofit `slices[]` entry's recorded bounds against the
 * ACTUAL on-disk marker frame (module header: the recorded absolute
 * bounds carry a per-room offset bug; the recorded SPAN does not). Falls
 * back to the entry's own recorded bounds, verbatim, when no matching
 * marker frame is found — flagged in the return so callers/tests/the
 * report can see when that happened (never hit in tonight's own data).
 * @param {object[]} parsedFrames every frame this room's frames.jsonl
 *   parsed to, in file order (parse errors already filtered out by caller)
 * @param {object[]} slices from `classifyRoom`'s own `slices`
 * @returns {{ranges: [number, number][], grounded: boolean[]}} */
function groundRetrofitRanges(parsedFrames, slices) {
  const ranges = [];
  const grounded = [];
  for (const slice of slices) {
    const span = slice.house_last_seq - slice.house_first_seq;
    const marker = parsedFrames.find(
      (f) =>
        f.type === "house" &&
        f.note === "import-slice" &&
        (slice.stream == null || f.stream === slice.stream) &&
        (slice.exported_t == null || f.exported_t === slice.exported_t),
    );
    if (marker && typeof marker.seq === "number") {
      ranges.push([marker.seq, marker.seq + span]);
      grounded.push(true);
    } else {
      // no marker frame found on disk — fall back to the recorded bounds
      // verbatim (best effort; never hit in tonight's own three rooms).
      ranges.push([slice.house_first_seq, slice.house_last_seq]);
      grounded.push(false);
    }
  }
  return { ranges, grounded };
}

/**
 * @typedef {{
 *   kind: "not-imported"|"wholesale"|"wholesale-mixed"|"retrofit"|"retrofit-unresolvable",
 *   framesTotal?: number, stamped?: number, alreadyStamped?: number,
 *   outOfScope?: number, parseErrors?: number, usedFallback?: boolean,
 *   markerGrounded?: boolean[], outText?: string, warning?: string,
 * }} RoomPlan
 */

/** builds the rewritten `frames.jsonl` text for one room, without writing
 * anything — `stampImported` below is the only caller that ever touches
 * disk for the rewrite itself.
 * @param {string} runDir @returns {RoomPlan|null} null when this room has
 *   no frames.jsonl at all (not a room this tool has anything to do). */
export function planRoom(runDir) {
  const framesPath = join(runDir, "frames.jsonl");
  if (!existsSync(framesPath)) return null;
  const info = classifyRoom(runDir);
  if (info.kind === "not-imported") return { kind: "not-imported" };

  const raw = readFileSync(framesPath, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (trailingNewline) lines.pop();

  // one parse pass, reused for classification (marker grounding) AND the
  // per-line eligibility decision below — never parsed twice.
  /** @type {Array<{line: string, obj: object|null, parseError: boolean}>} */
  const parsed = lines.map((line) => {
    if (!line.trim()) return { line, obj: null, parseError: false };
    try {
      return { line, obj: JSON.parse(line), parseError: false };
    } catch {
      return { line, obj: null, parseError: true };
    }
  });

  if (info.kind === "wholesale" && !wholesaleIsSafe(runDir))
    return {
      kind: "wholesale-mixed",
      warning:
        "run.json sessions include a non-imported entry — this room is not purely import content; skipped, needs manual review",
    };

  /** @type {[number, number][]|null} null = "every frame qualifies" (wholesale) */
  let ranges = null;
  let usedFallback = false;
  /** @type {boolean[]|undefined} */
  let markerGrounded;
  if (info.kind === "retrofit") {
    if (info.hasMarker) {
      const parsedFrames = parsed.filter((p) => p.obj).map((p) => p.obj);
      const g = groundRetrofitRanges(parsedFrames, info.slices);
      ranges = g.ranges;
      markerGrounded = g.grounded;
    } else if (info.originalLastHouseSeq != null) {
      usedFallback = true;
    } else {
      return {
        kind: "retrofit-unresolvable",
        warning:
          "imported.retrofit is true but neither a slices[] house_first_seq/house_last_seq marker nor original_last_house_seq is present — skipped, needs manual review",
      };
    }
  }

  let framesTotal = 0;
  let stamped = 0;
  let alreadyStamped = 0;
  let outOfScope = 0;
  let parseErrors = 0;
  const outLines = new Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const { line, obj, parseError } = parsed[i];
    if (parseError) {
      parseErrors += 1;
      outLines[i] = line;
      continue;
    }
    if (obj === null) {
      outLines[i] = line; // a blank line
      continue;
    }
    framesTotal += 1;
    if (Object.prototype.hasOwnProperty.call(obj, "origin")) {
      alreadyStamped += 1;
      outLines[i] = line;
      continue;
    }
    let eligible;
    if (info.kind === "wholesale") {
      eligible = true;
    } else if (usedFallback) {
      const seq = obj.seq;
      const tMs = typeof obj.t === "string" ? Date.parse(obj.t) : Number.NaN;
      eligible =
        typeof seq === "number" &&
        seq > /** @type {number} */ (info.originalLastHouseSeq) &&
        !Number.isNaN(tMs) &&
        tMs < RESTORE_START_MS;
    } else {
      eligible = typeof obj.seq === "number" && inAnyRange(obj.seq, /** @type {[number, number][]} */ (ranges));
    }
    if (eligible) {
      stamped += 1;
      outLines[i] = stampLine(line);
    } else {
      outOfScope += 1;
      outLines[i] = line;
    }
  }

  return {
    kind: info.kind === "wholesale" ? "wholesale" : "retrofit",
    framesTotal,
    stamped,
    alreadyStamped,
    outOfScope,
    parseErrors,
    usedFallback,
    ...(markerGrounded ? { markerGrounded } : {}),
    outText: outLines.join("\n") + (trailingNewline ? "\n" : ""),
  };
}

/** the tmp-file-in-same-dir + rename this task's brief names as the ONE
 * in-place write to the runs volume it allows, and only through `--real`
 * (`dryRun: false` here). @param {string} path @param {string} content */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-stamp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * @param {{runsDir: string, dryRun?: boolean}} args
 * @returns {{
 *   totals: {roomsTouched: number, framesStamped: number, framesAlreadyStamped: number,
 *     framesOutOfScope: number, parseErrors: number, roomsSkippedNotImported: number,
 *     roomsSkippedMixed: number, roomsSkippedUnresolvable: number},
 *   perRoom: Array<{id: string} & RoomPlan>,
 * }}
 */
export function stampImported({ runsDir, dryRun = true }) {
  const totals = {
    roomsTouched: 0,
    framesStamped: 0,
    framesAlreadyStamped: 0,
    framesOutOfScope: 0,
    parseErrors: 0,
    roomsSkippedNotImported: 0,
    roomsSkippedMixed: 0,
    roomsSkippedUnresolvable: 0,
  };
  const perRoom = [];
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return { totals, perRoom };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const plan = planRoom(runDir);
    if (!plan) continue;
    if (plan.kind === "not-imported") {
      totals.roomsSkippedNotImported += 1;
      continue;
    }
    if (plan.kind === "wholesale-mixed") {
      totals.roomsSkippedMixed += 1;
      perRoom.push({ id: entry.name, ...plan });
      continue;
    }
    if (plan.kind === "retrofit-unresolvable") {
      totals.roomsSkippedUnresolvable += 1;
      perRoom.push({ id: entry.name, ...plan });
      continue;
    }
    totals.framesStamped += plan.stamped ?? 0;
    totals.framesAlreadyStamped += plan.alreadyStamped ?? 0;
    totals.framesOutOfScope += plan.outOfScope ?? 0;
    totals.parseErrors += plan.parseErrors ?? 0;
    if ((plan.stamped ?? 0) > 0) {
      totals.roomsTouched += 1;
      if (!dryRun) writeAtomic(join(runDir, "frames.jsonl"), /** @type {string} */ (plan.outText));
    }
    const { outText, ...rest } = plan;
    perRoom.push({ id: entry.name, ...rest });
  }
  return { totals, perRoom };
}

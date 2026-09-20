// @ts-check
/* The resident life's frame -> message mapping and per-(run, handle)
 * append bookkeeping, beside resident-life.mjs (opening/compiling a life;
 * room-reach.mjs owns the routing rule). OWNS: `readFramesJsonl`,
 * `findRestReason`, `provenanceOf`; `buildFullMessages` (one call per
 * SESSION's new frames); the append marker `<runDir>/life.appended.
 * <handle>.json` = `{through_seq, sessions}` (legacy single-file marker
 * reads "everything appended" for the PRIMARY handle only, `being ??
 * owner`; `seedJoinMarker` starts a late joiner's marker at the room's
 * current seq, never -1); `hydrateTail`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameText as frameTextOf } from "./trace.mjs";

// Inlined from a private deployment's walk-attachments.mjs (a being-
// container-side module, out of scope for this port) — this one pure
// formatter is all life-entries.mjs needs from it.
/** @param {{by: string, kind: string, path: string, filename?: string|null}} att */
function attachmentLabel({ by, kind, path, filename }) {
  return kind === "image"
    ? `image from @${by}: ${path}`
    : `file from @${by}: ${filename ?? path}, ${path}`;
}

/** @typedef {{run: string, kind: string, class: string|null, room: string,
 *   people: string[], visibility: "public"|"private", session: number,
 *   provenance?: "imported"|"lived"}} PeriodBase */
/** @typedef {{through_seq: number, sessions: Array<{through_seq: number, t: string}>}} AppendMarker */

/* ==========================================================================
 * frames.jsonl
 * ========================================================================== */

/** A run dir's own frames, parsed in order — a truncated tail line (a
 * crash mid-write) is an honest absence, never a throw; a missing
 * frames.jsonl reads as no frames at all. */
export function readFramesJsonl(runDir) {
  let text = "";
  try {
    text = readFileSync(join(runDir, "frames.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** "imported" when the run's class.json carries an `imported` block (a
 * platform history poured in, never lived by this process), else "lived".
 * @param {string} runDir @returns {"imported"|"lived"} */
export function provenanceOf(runDir) {
  try {
    const cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    return cls?.imported && typeof cls.imported === "object" ? "imported" : "lived";
  } catch {
    return "lived";
  }
}

/** the rest reason for `runId` — a wake/sleep alarm clock (a private
 * deployment's alarm-store.mjs) isn't part of this port (product-layer
 * scheduling, not the house's record), so there is never a recorded
 * reason here; harmlessly absent, same as for a plain visit. A deployment
 * that reintroduces such a clock can widen this function to read it. */
export function findRestReason(_privateRoot, _handle, _runId) {
  return null;
}

/* ==========================================================================
 * the per-(run, handle) append marker
 * ========================================================================== */

function markerPath(runDir, handle) {
  return join(runDir, `life.appended.${handle}.json`);
}

/** `handle`'s own append progress against `runDir` — the per-handle file
 * when it exists, else a translation of the legacy single-file marker
 * (module header) for the run's primary handle, else null. Never throws:
 * a corrupt marker of either shape reads as null, redone from scratch.
 * @param {string} runDir @param {string} handle @returns {AppendMarker | null} */
export function readAppendMarker(runDir, handle) {
  const p = markerPath(runDir, handle);
  if (existsSync(p)) {
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      if (typeof m.through_seq === "number" && Array.isArray(m.sessions)) return m;
    } catch {
      /* corrupt — fall through to legacy/null, never trusted blind */
    }
  }

  let cls;
  try {
    cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  } catch {
    return null;
  }
  const being = typeof cls.being === "string" ? cls.being : null;
  const owner = typeof cls.owner === "string" ? cls.owner : null;
  if (handle !== (being ?? owner)) return null;

  const legacyPath = join(runDir, "life.appended.json");
  if (!existsSync(legacyPath)) return null;
  try {
    const old = JSON.parse(readFileSync(legacyPath, "utf8"));
    const frames = readFramesJsonl(runDir);
    const lastSeq = frames.length ? (frames[frames.length - 1].seq ?? frames.length - 1) : -1;
    return {
      through_seq: lastSeq,
      sessions: [
        { through_seq: lastSeq, t: typeof old.at === "string" ? old.at : new Date().toISOString() },
      ],
    };
  } catch {
    return null;
  }
}

/** @param {string} runDir @param {string} handle @param {AppendMarker} marker */
export function writeAppendMarker(runDir, handle, marker) {
  writeFileSync(markerPath(runDir, handle), JSON.stringify(marker, null, 2));
}

/** Seeds `handle`'s marker at the room's CURRENT last frame when it joins
 * an already-open room, so its first `appendPeriod` offers only frames
 * from its own join onward. No-op once a marker exists (never rewound).
 * @param {string} runDir @param {string} handle */
export function seedJoinMarker(runDir, handle) {
  if (existsSync(markerPath(runDir, handle))) return;
  const frames = readFramesJsonl(runDir);
  const last = frames[frames.length - 1];
  writeAppendMarker(runDir, handle, {
    through_seq: last ? (last.seq ?? frames.length - 1) : -1,
    sessions: [],
  });
}

/** the marker after folding in one more session's worth of `newFrames`
 * (non-empty by every caller) — appends `{through_seq, t}`, top-level
 * `through_seq` tracking the same value (the last of `newFrames`).
 * @param {AppendMarker | null} marker @param {Array<{seq?: number}>} newFrames
 * @returns {AppendMarker} */
export function advanceMarker(marker, newFrames) {
  const last = newFrames[newFrames.length - 1];
  const throughSeq =
    typeof last.seq === "number" ? last.seq : (marker?.through_seq ?? -1) + newFrames.length;
  const sessions = marker ? [...marker.sessions] : [];
  sessions.push({ through_seq: throughSeq, t: new Date().toISOString() });
  return { through_seq: throughSeq, sessions };
}

/* ==========================================================================
 * frame -> message mapping
 * ========================================================================== */

/** How much of a human/spoken turn's own text the life stores directly —
 * the rest is a pointer, never dropped (the record keeps the whole). */
export const LIFE_EXCERPT_CHARS = 400;
/** reach.result's own elbow — wider, since tool output is bulkier and
 * rarely the being's own voice; `record_read` reaches the whole. */
export const REACH_RESULT_EXCERPT_CHARS = 2000;

/** a peer's speech at `frames[i]`, mirrored straight back in as the VERY
 * NEXT frame — a bridged platform (docs/harness-port/32-life-peer-dedupe.md:
 * a room's own Signal seat, confirmed live 2026-09-20) echoing the peer's
 * own just-sent speech back in as an "inbound" `message`, same `by`, same
 * text. One utterance, two frames — this finds the echo so the caller can
 * fold them to one entry instead of two. Adjacency + exact-text match only
 * (the observed shape: seq N speech, seq N.5 message, byte-identical text):
 * a genuinely separate message from the same peer a moment later is never
 * folded, and a peer's speech with no echo at all is untouched.
 * @param {any[]} frames @param {number} i @param {string} by @param {string} text
 * @returns {{seq: number}|null} */
function peerEchoMessage(frames, i, by, text) {
  const g = frames[i + 1];
  return g && g.type === "message" && g.by === by && String(g.text ?? "") === text ? g : null;
}

/** whose turn a reach at `frames[i]` belongs to: reach frames carry no
 * `by`, so it is the `by` of the next speech frame of the same turn (an
 * interim precedes the tools, the final closes the turn); null past an
 * `aborted`/`error`/period end — a turn that left no speech. */
function reachOwner(frames, i) {
  for (let j = i + 1; j < frames.length; j++) {
    const g = frames[j];
    if (g.type === "speech") return typeof g.by === "string" ? g.by : null;
    if (["aborted", "error", "rested", "dissolved"].includes(g.type)) return null;
  }
  return null;
}

/** the fold pass summarises whatever text it's given and can't re-resolve
 * a summary against the original — so the excerpt IS what memory gets once
 * folded; the record keeps the whole. `metadata.ref` (stamped by every
 * caller alongside this excerpt) is what actually carries the pointer for
 * `hydrateTail`/`compileFor` to find — matched by the message's own exact
 * text, never by parsing this marker back out of it. So the `[held in
 * …]` text rides ONLY when something was actually cut (the reader has
 * something real to reach for); a short message that made it in whole
 * carries none — nothing to point past. Same rule reach.result already
 * followed on its own (below); this just brings the shorter excerpt path
 * in line with it. Exported so a test can pin the marker rule directly,
 * without a full appendPeriod/compileFor round trip. */
export function excerptWithPointer(text, runId, seq) {
  const truncated = text.length > LIFE_EXCERPT_CHARS;
  const excerpt = text.slice(0, LIFE_EXCERPT_CHARS);
  return truncated ? `${excerpt}… [held in ${runId}#${seq}]` : excerpt;
}

/** Frame -> life-message mapping for ONE session's new frames; every
 * message carries `metadata.period`. Reach/reach.result pair by `callId`
 * into tool_use + a tool_result; an unpaired half is dropped, never
 * appended stray. Attribution: a speech is this being's own unless `by`
 * names a `peer`, whose words enter under their own name; a peer's reach
 * folds to one house line, its result left to the record.
 *
 * `displayFor` (platform-reach's human-display round, harness-port
 * docs/harness-port/37-human-display.md): optional, injected rather than
 * imported (this file stays independent of identity-map.mjs and its
 * PRIVATE_DIR — a test that only exercises frame->message mapping never
 * needs to sandbox a private root it has no other reason to touch) —
 * default `() => null`, an honest "no display known," matching every
 * caller that doesn't pass one. A HUMAN's `by` (never a peer, never this
 * being's own handle — bots/beings keep their handles as today) is shown
 * as `displayFor(by) ?? by`: the kept pseudonym itself never rides bare
 * into a being's own context, current or compiled, once the house knows a
 * platform display for it. FRAME fields (`by`, `metadata.ref`) are
 * untouched — only the rendered participant/text a being actually reads.
 * @param {{frames: any[], handle: string, peers?: Set<string>, runDir: string,
 *   runId: string, periodBase: PeriodBase, closingFrame: any,
 *   restReason: string|null, displayFor?: (handle: string) => string|null}} args
 */
export function buildFullMessages({
  frames,
  handle,
  peers = new Set(),
  runDir,
  runId,
  periodBase,
  closingFrame,
  restReason,
  displayFor = () => null,
}) {
  const out = [];
  let seq = 0;
  // a fellow being (or this resident's own handle, though that never
  // reaches here as a bare `by`) keeps its handle unchanged; a human's is
  // shown by its current display when the house has one.
  const humanLabel = (by) => (by == null || peers.has(by) ? by : (displayFor(by) ?? by));
  // the provenance class (docs/the-river-guides-welfare.md's third: prior-
  // conversation verbatim, imported) rides every period message; stamped
  // from class.json.imported unless the caller already named it.
  const provenance = periodBase.provenance ?? provenanceOf(runDir);
  const withPeriod = () => ({ ...periodBase, provenance, seq: seq++ });
  const pendingReach = new Map(); // callId -> index into `out`
  const foldedEcho = new Set(); // seqs of `message` frames already folded into a peer's speech, above
  const houseLine = (text) =>
    out.push({
      participant: "house",
      content: [{ type: "text", text }],
      metadata: { period: withPeriod() },
    });

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    switch (f.type) {
      case "message": {
        if (foldedEcho.has(f.seq)) break; // folded into the paired peer speech below — one entry, not two
        // a waking's mechanical opening line is `by` this resident's own
        // handle — relabeled "house" (it did not ask itself anything).
        const participant = !f.by || f.by === handle ? "house" : humanLabel(f.by);
        const text = String(f.text ?? "");
        out.push({
          participant,
          content: [{ type: "text", text: excerptWithPointer(text, runId, f.seq) }],
          metadata: { period: withPeriod(), ref: { run: runId, seq: f.seq } },
        });
        break;
      }
      case "speech": {
        if (f.interim) break;
        const text = frameTextOf(f, runDir);
        if (!text.trim()) break;
        // a `by` naming no peer is this being's own — a legacy solo walk
        // stamps a model-derived slug there, not the handle. Own-being
        // speech is never echo-folded (peerEchoMessage below is only
        // consulted for a peer) — the room's own report named this scope
        // deliberately: a bridged platform's self-echo is observed for
        // peers, and folding an own turn's speech is a different question
        // this task didn't ask.
        const isPeer = peers.has(f.by);
        const echo = isPeer ? peerEchoMessage(frames, i, f.by, text) : null;
        if (echo) foldedEcho.add(echo.seq);
        // the message frame is what the platform delivered and what the
        // record indexes (docs/harness-port/32-life-peer-dedupe.md) — the
        // ref points there when an echo folded, else at the speech itself.
        const refSeq = echo ? echo.seq : f.seq;
        out.push({
          participant: isPeer ? f.by : handle,
          content: [{ type: "text", text: excerptWithPointer(text, runId, refSeq) }],
          metadata: { period: withPeriod(), ref: { run: runId, seq: refSeq } },
        });
        break;
      }
      case "media.attached":
        houseLine(`[${attachmentLabel({ ...f, by: humanLabel(f.by) })} — held in ${runId}#${f.seq}]`);
        break;
      case "reach": {
        const by = reachOwner(frames, i);
        if (peers.size && (by == null || peers.has(by))) {
          houseLine(`[${by == null ? "a walker" : `@${by}`} reached ${f.tool}]`);
          break; // the result finds no tool_use to pair with — left to the record
        }
        const id = `r${f.seq}`;
        out.push({
          participant: handle,
          content: [{ type: "tool_use", id, name: f.tool, input: f.input ?? {} }],
          metadata: { period: withPeriod() },
        });
        if (typeof f.callId === "string") pendingReach.set(f.callId, out.length - 1);
        break;
      }
      case "reach.result": {
        const index = typeof f.callId === "string" ? pendingReach.get(f.callId) : undefined;
        if (index === undefined) break; // no matching reach seen — an orphan half
        pendingReach.delete(f.callId);
        const toolUseId = /** @type {{id: string}} */ (out[index].content[0]).id;
        const full = frameTextOf(f, runDir);
        const truncated = full.length > REACH_RESULT_EXCERPT_CHARS;
        const text =
          full.slice(0, REACH_RESULT_EXCERPT_CHARS) +
          (truncated ? `\n[…held in ${runId}#${f.seq}; record_read reaches the whole result]` : "");
        out.push({
          participant: "user",
          content: [{ type: "tool_result", toolUseId, content: [{ type: "text", text }] }],
          metadata: { period: withPeriod() },
        });
        break;
      }
      case "note.filed":
        houseLine(`[filed] ${f.path ?? ""}`);
        break;
      case "threshold.receipt":
        houseLine(String(f.text ?? ""));
        break;
      case "retracted": // a consent-bearing marker: the fact, never the text
        houseLine("[a message was withdrawn]");
        break;
      case "hidden":
        houseLine(`[hidden by ${(f.by ?? []).map((h) => `@${humanLabel(h)}`).join(", ") || "no one now"}]`);
        break;
      default:
        break; // world.mounted/auto.state/participant.*/error/aborted/stage.*/branch.* — record_read holds them.
    }
  }

  // drop any tool_use whose reach.result never landed (including one whose
  // result only arrives in a LATER session — an accepted edge case)
  for (const index of pendingReach.values()) out[index] = null;
  const paired = out.filter(Boolean);

  const closingKind =
    closingFrame && (closingFrame.type === "rested" || closingFrame.type === "dissolved")
      ? closingFrame.type
      : null;
  if (closingKind) {
    paired.push({
      participant: "house",
      content: [
        {
          type: "text",
          text: `[period ended] ${closingKind}${restReason ? ` — ${restReason}` : ""}`,
        },
      ],
      metadata: { period: { ...withPeriod(), ended_t: closingFrame?.t ?? null } },
    });
  }

  return paired;
}

/* ==========================================================================
 * hydration at compile
 * ========================================================================== */

/** `runId#seq`'s own full text (trace.mjs's general resolver — inline/
 * blob/file/preview), or null on any miss (archived run, unwritten seq) —
 * honest, never a throw. */
function resolveFrameText(runsRoot, runId, seq) {
  try {
    const dir = join(runsRoot, runId);
    const frame = readFramesJsonl(dir).find((f) => f.seq === seq);
    if (!frame) return null;
    return frameTextOf(frame, dir);
  } catch {
    return null;
  }
}

/** Replaces a compiled message's pointer+excerpt with the FULL frame text
 * wherever it's BYTE-IDENTICAL to a message still live in `cm`'s own store
 * carrying `metadata.ref` (`compile()` strips messages to `{participant,
 * content}`, so an exact match is the only "was this folded" signal — a
 * fold's synthesized prose never reproduces the excerpt's own pointer
 * verbatim). Never mutates `messages`; `runsRoot` spans a life's whole
 * history, not only the run being compiled for.
 * @param {InstanceType<import("@animalabs/context-manager").ContextManager>} cm
 * @param {Array<{participant: string, content: Array<{type: string, text?: string}>}>} messages
 * @param {string} runsRoot
 * @returns {{messages: typeof messages, hydrated: number}}
 */
export function hydrateTail(cm, messages, runsRoot) {
  /** @type {Map<string, {run: string, seq: number}>} */
  const refByText = new Map();
  for (const m of cm.getAllMessages()) {
    const ref = /** @type {{run?: unknown, seq?: unknown}|undefined} */ (m.metadata?.ref);
    if (!ref || typeof ref.run !== "string" || typeof ref.seq !== "number") continue;
    for (const block of m.content ?? []) {
      if (typeof block?.text === "string")
        refByText.set(block.text, { run: ref.run, seq: ref.seq });
    }
  }
  if (!refByText.size) return { messages, hydrated: 0 };

  let hydrated = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((block) => {
      if (typeof block?.text !== "string") return block;
      const ref = refByText.get(block.text);
      if (!ref) return block;
      const full = resolveFrameText(runsRoot, ref.run, ref.seq);
      if (full == null) return block; // unresolved — the excerpt stands, never a throw
      hydrated++;
      changed = true;
      return { ...block, text: full };
    });
    return changed ? { ...m, content } : m;
  });
  return { messages: out, hydrated };
}

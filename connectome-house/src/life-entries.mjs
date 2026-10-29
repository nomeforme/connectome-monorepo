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
import { buildMessageIndex } from "./mcpl/message-index.mjs";
import { echoForm } from "./mcpl/pending-outbound.mjs";

// Inlined from a private deployment's walk-attachments.mjs (a being-
// container-side module, out of scope for this port) — this one pure
// formatter is all life-entries.mjs needs from it.
/** @param {{by: string, kind: string, path: string, filename?: string|null}} att */
function attachmentLabel({ by, kind, path, filename, mime }) {
  return kind === "image"
    ? `image from @${by}: ${path}`
    : `file from @${by}: ${filename ?? path}${mime ? ` (${mime})` : ""}, ${path}`;
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
 * rarely the being's own voice; the record keeps the whole. */
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
  return g && g.type === "message" && g.by === by && sameEcho(String(g.text ?? ""), text) ? g : null;
}

/** a platform's copy of a spoken line, compared as the platform renders
 * it (pending-outbound.mjs's echoForm — the same form the write-side
 * ledger matches on; this fold remains for records written before it) */
function sameEcho(a, b) {
  return a === b || (echoForm(a) !== "" && echoForm(a) === echoForm(b));
}

/** what the record's own later frames say about earlier ones, resolved to
 * now: the seqs hidden (🫥 — the last `hidden` frame per target wins; an
 * empty `by` is visible again), the seqs withdrawn (deleted on the
 * platform), and each edited seq's final text.
 * @param {any[]} frames */
export function recordMeta(frames) {
  const hidden = new Set();
  const retracted = new Set();
  const edited = new Map();
  for (const f of frames) {
    if (typeof f?.target !== "number") continue;
    if (f.type === "hidden") Array.isArray(f.by) && f.by.length ? hidden.add(f.target) : hidden.delete(f.target);
    else if (f.type === "retracted") retracted.add(f.target);
    else if (f.type === "edited" && typeof f.text === "string") edited.set(f.target, f.text);
  }
  return { hidden, retracted, edited };
}

/** the being's OWN spoken line, mirrored straight back as the very next
 * frame (`message` under its handle) — the platform's copy of what it just
 * said, never a second thing said (it rendered as the house repeating it) */
function isOwnEcho(frames, i, handle, runDir) {
  const f = frames[i];
  if (f?.type !== "message" || f.by !== handle) return false;
  const prev = frames[i - 1];
  return prev?.type === "speech" && prev.by === handle && sameEcho(String(f.text ?? ""), frameTextOf(prev, runDir) ?? "");
}

/** whose turn a reach at `frames[i]` belongs to: reach frames carry no
 * `by`, so it is the `by` of the next speech frame of the same turn (an
 * interim precedes the tools, the final closes the turn); null past an
 * `aborted`/`error`/period end — a turn that left no speech. */
function reachOwner(frames, i) {
  // a reach stamped with its caller (every reach written since 2026-10-05)
  // says whose it is; older ones fall back to whoever spoke next
  if (typeof frames[i]?.by === "string") return frames[i].by;
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

/** what a message frame's text is prefixed with, when the being's
 * covenant opts in (`reply_marker: true`; off by default), if it is a
 * platform reply to one of the rendering being's own posted lines — so the
 * model can see which message it is answering. Rendered per being, never
 * stored in the room's record (the participant name stays the membrane's
 * own `Name: ` prefix). @param {string} handle @returns {string} */
export const replyMark = (handle) => `<replying to @${handle}> `;
const REPLY_MARK_RE = /^<replying to @[^>\s]+> /;

/** seqs of `message` frames in `runDir` that platform-reply to one of
 * `handle`'s own posted lines: external.jsonl's inbound `reply_to` checked
 * against `handle`'s own outbound/echo message ids, paired to frames by
 * message-index.mjs. An empty set on any miss — never a throw.
 * @param {string} runDir @param {string} handle @returns {Set<number>} */
export function repliesToHandle(runDir, handle) {
  const out = new Set();
  let lines;
  try {
    lines = readFileSync(join(runDir, "external.jsonl"), "utf8").split("\n");
  } catch {
    return out;
  }
  const own = new Set();
  const replies = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.message_id == null) continue;
    if (r.direction === "out" && r.by === handle && r.delivered !== false) own.add(String(r.message_id));
    else if (r.direction === "in" && typeof r.echo_of_seq === "number") {
      if (r.author === handle) own.add(String(r.message_id));
    } else if (r.direction === "in" && r.reply_to != null && r.author !== handle) replies.push(r);
  }
  const hits = replies.filter((r) => own.has(String(r.reply_to)));
  if (!hits.length) return out;
  const index = buildMessageIndex(runDir);
  for (const r of hits) {
    const sq = index.get(String(r.message_id));
    if (typeof sq === "number") out.add(sq);
  }
  return out;
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
 *   restReason: string|null, displayFor?: (handle: string) => string|null,
 *   fullText?: boolean, inlineMedia?: ((frame: any) => any) | null}} args
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
  fullText = false,
  inlineMedia = null,
  replyMarker = false,
}) {
  const out = [];
  // a turn's own live conversation rides whole (fullText); only a life's
  // stored copy is cut to an excerpt + pointer
  const textOf = (text, run, s) => (fullText ? text : excerptWithPointer(text, run, s));
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

  // 🫥 takes a line out of context (and putting it back returns it), a
  // platform delete withdraws it, an edit replaces its text — as the fleet
  // treated each
  const meta = recordMeta(frames);
  const gone = (sq) => meta.hidden.has(sq) || meta.retracted.has(sq);
  /** @type {Set<number>|null} */
  let replySeqs = null; // read once, on the first message frame
  const repliesToMe = (sq) => (replySeqs ??= repliesToHandle(runDir, handle)).has(sq);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    switch (f.type) {
      case "message": {
        if (foldedEcho.has(f.seq)) break; // folded into the paired peer speech below — one entry, not two
        if (isOwnEcho(frames, i, handle, runDir)) break; // the platform's copy of this being's own line
        if (gone(f.seq)) break;
        // a waking's mechanical opening line is `by` this resident's own
        // handle — relabeled "house" (it did not ask itself anything).
        const participant = !f.by || f.by === handle ? "house" : humanLabel(f.by);
        const text = meta.edited.get(f.seq) ?? String(f.text ?? "");
        const mark = replyMarker && participant !== "house" && repliesToMe(f.seq) ? replyMark(handle) : "";
        out.push({
          participant,
          content: [{ type: "text", text: mark + textOf(text, runId, f.seq) }],
          metadata: { period: withPeriod(), ref: { run: runId, seq: f.seq } },
        });
        break;
      }
      case "speech": {
        // a spoken line is reacted to / deleted on the platform through its
        // posted copy (the next frame), or through the speech itself
        const next = frames[i + 1];
        const posted =
          next?.type === "message" && next.by === f.by && sameEcho(String(next.text ?? ""), frameTextOf(f, runDir) ?? "") ? next : null;
        if (gone(f.seq) || (posted && gone(posted.seq))) {
          if (posted) foldedEcho.add(posted.seq);
          break;
        }
        const text = meta.edited.get(f.seq) ?? frameTextOf(f, runDir);
        if (!text.trim()) break;
        // `!stop`'s notice is posted as the being (fleet parity) but is the
        // house's word, not the being's — never an own line in its memory
        if (f.notice === "cycle-stopped") {
          houseLine(`[${f.by === handle || !peers.has(f.by) ? "your" : `@${f.by}'s`} turn was stopped (!stop)]`);
          break;
        }
        // interim words (between tool calls; never posted to the platform)
        // are this being's own — they ride as its lines, as they did in its
        // turn. A peer's interim reached no one, so it never rides.
        if (f.interim && peers.has(f.by)) break;
        // a `by` naming no peer is this being's own — a legacy solo walk
        // stamps a model-derived slug there, not the handle. Own-being
        // speech is never echo-folded (peerEchoMessage below is only
        // consulted for a peer) — the room's own report named this scope
        // deliberately: a bridged platform's self-echo is observed for
        // peers, and folding an own turn's speech is a different question
        // this task didn't ask.
        const isPeer = peers.has(f.by);
        const echo = isPeer && !f.interim ? peerEchoMessage(frames, i, f.by, text) : null;
        if (echo) foldedEcho.add(echo.seq);
        // the message frame is what the platform delivered and what the
        // record indexes (docs/harness-port/32-life-peer-dedupe.md) — the
        // ref points there when an echo folded, else at the speech itself.
        const refSeq = echo ? echo.seq : f.seq;
        out.push({
          participant: isPeer ? f.by : handle,
          content: [{ type: "text", text: textOf(text, runId, refSeq) }],
          metadata: { period: withPeriod(), ref: { run: runId, seq: refSeq } },
        });
        break;
      }
      case "media.attached": {
        const label = `[${attachmentLabel({ ...f, by: humanLabel(f.by) })} — held in ${runId}#${f.seq}]`;
        // a turn's live conversation may carry the thing itself (the room's
        // newest few — media-inline.mjs decides); a life only the pointer
        const block = inlineMedia?.(f) ?? null;
        if (block) {
          // under its sender's own name, as the old fleet put an image in
          // the sender's own message — the model sees who showed it
          out.push({
            participant: f.by == null || f.by === handle ? "house" : humanLabel(f.by),
            content: [{ type: "text", text: label }, block],
            metadata: { period: withPeriod() },
          });
        } else if (f.kind !== "image" && inlineMedia) {
          // a file the model can't take in as it is (a doc, audio, an old
          // PDF): where it is, and how to work with it — the old fleet's
          // own "[Attached files — use save_attachment …]" note
          houseLine(`${label.slice(0, -1)}; save_attachment puts it in /workspace/shared]`);
        } else houseLine(label);
        break;
      }
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
        // a turn's live conversation carries a tool result near-whole (a
        // ceiling only against a runaway fetch); a life's copy, the excerpt
        const cap = fullText ? 20_000 : REACH_RESULT_EXCERPT_CHARS;
        const truncated = full.length > cap;
        const text = full.slice(0, cap) + (truncated ? `\n[…held in ${runId}#${f.seq}]` : "");
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
      case "hidden": // applied above: the hidden line simply isn't there —
        // only a platform's own note (a board post removed by flags) speaks,
        // and only while the post is still hidden (a lifted hide says nothing)
        if (typeof f.note === "string" && f.note && meta.hidden.has(f.target)) houseLine(f.note);
        break;
      case "edited":
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
export function hydrateTail(cm, messages, runsRoot, { maxTokens } = {}) {
  // `maxTokens` (a being whose covenant names its model's real window):
  // the compile sized `messages` to the budget with excerpts, so full text
  // may only grow it up to that budget — newest first, each restored line
  // whole or not at all; past the first one that doesn't fit, the older
  // lines keep the excerpt the store holds them as (2026-10-29: plantoid's
  // 27k-budget life shipped at ~67k once hydrated, and its 64k model
  // refused every turn in that room)
  if (typeof maxTokens === "number") return hydrateWithin(cm, messages, runsRoot, maxTokens);
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
      // the reply marker is the render's, not the frame's — kept
      const lead = REPLY_MARK_RE.exec(block.text)?.[0] ?? "";
      return { ...block, text: lead + full };
    });
    return changed ? { ...m, content } : m;
  });
  return { messages: out, hydrated };
}

/** hydrateTail under a token ceiling (see there): walks newest to oldest,
 * restoring a message's full text only while the whole stays within
 * `maxTokens` (~4 chars/token over the JSON, the turn log's own measure);
 * stops at the first that would cross it, so what's verbatim is always a
 * contiguous newest stretch. */
function hydrateWithin(cm, messages, runsRoot, maxTokens) {
  /** @type {Map<string, {run: string, seq: number}>} */
  const refByText = new Map();
  for (const m of cm.getAllMessages()) {
    const ref = /** @type {{run?: unknown, seq?: unknown}|undefined} */ (m.metadata?.ref);
    if (!ref || typeof ref.run !== "string" || typeof ref.seq !== "number") continue;
    for (const block of m.content ?? []) if (typeof block?.text === "string") refByText.set(block.text, { run: ref.run, seq: ref.seq });
  }
  if (!refByText.size) return { messages, hydrated: 0 };
  const cost = (v) => Math.ceil(JSON.stringify(v).length / 4);
  let used = cost(messages);
  let hydrated = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!Array.isArray(m.content)) continue;
    let changed = false;
    let restored = 0;
    const content = m.content.map((block) => {
      if (typeof block?.text !== "string") return block;
      const ref = refByText.get(block.text);
      if (!ref) return block;
      const full = resolveFrameText(runsRoot, ref.run, ref.seq);
      if (full == null) return block;
      restored++;
      changed = true;
      const lead = REPLY_MARK_RE.exec(block.text)?.[0] ?? "";
      return { ...block, text: lead + full };
    });
    if (!changed) continue;
    const next = { ...m, content };
    const grown = used - cost([m]) + cost([next]);
    if (grown > maxTokens) break; // older lines keep their excerpts
    out[i] = next;
    used = grown;
    hydrated += restored;
  }
  return { messages: out, hydrated };
}

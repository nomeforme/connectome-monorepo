// @ts-check
/* connectome-history-import/src/slice.mjs — appends a LATER slice of a
 * stream to a room this importer already wrote, OR — the retrofit case,
 * `docs/harness-port/21-restore-rehearsal.md` — to a room the HOUSE itself
 * minted live, with no `imported` field at all, when older VEIL history
 * for the same stream exists and needs to land underneath what's already
 * live (docs/harness-port/04-history-restore.md §6, the K4 decision: a
 * late slice is accepted and marked, never re-ordered — a staging buffer
 * would mean a second live copy of the same text existed for however long
 * it held, which contradicts the house's single-writer, one-verbatim-copy
 * design). `cli.mjs`'s own bulk sweep FINDS such a room (the house's own
 * `findRoom`, same platform+stream) and correctly never mints a duplicate
 * for it — but its own skip leaves that room's pre-live VEIL history out
 * entirely, reported, never appended (`cli.mjs`'s own "see slice.mjs" skip
 * reason). This file is where that append actually happens, for BOTH
 * shapes of "a room already on disk": one this importer wrote before
 * (`cls.imported` present — the ordinary late-slice case), and one the
 * house wrote live (`cls.imported` absent — the retrofit case, `imported`
 * is created here for the first time, tagged `retrofit: true`, so a later
 * reader can tell this room carried live history before any restore ran
 * against it). Frames.jsonl is append-only either way — a retrofit slice
 * can only land AFTER the room's existing (live) frames, never spliced in
 * before them at their true chronological position (the PRE-slice
 * `04-history-restore.md` §6 imagines the format can't literally do); it
 * is still a K4 late slice, just one whose "already on disk" side happens
 * to be lived rather than previously imported.
 *
 * Select: items/marks whose `veilSeq` is past `last_seq` (or past nothing
 * at all, for a room with no prior `imported.last_seq` — every matching
 * VEIL frame is "new" to it). Dedupe: any item whose external id
 * (`records.mjs`'s `externalIdOf`) is already in the room's
 * external.jsonl, either direction — this also protects a retrofit slice
 * from double-counting a message the live seat and the VEIL archive both
 * happen to know about. Write: one late-slice marker — the house's
 * `Frame` schema has no dedicated "this is a later import slice" type, so
 * this rides the generic `house` frame (frame-schema.mjs's `HouseFrame` —
 * "a house-authored fact with no single speaker"), tagged
 * `note: "import-slice"` — then the new frames through the same per-item
 * mapping `records.mjs` uses, then a closing `rested`. Refuses unless the
 * room is at rest and no other import holds its `.import.lock`. Idempotent:
 * every id from a prior run is already in external.jsonl, so a re-run
 * selects nothing new.
 *
 * NOT implemented (flagged for the cutover round that needs it): the fuzzy
 * secondary match for stand-in ids inside a cutover overlap window (same
 * `by`, same text, `|Δt| <= 120s`, 04-history-restore.md §6's "Stand-in
 * ids" paragraph) — this slice only dedupes by exact external id. An edit
 * mark landing on a facet from a PRIOR slice DOES reconnect (`houseSeqOfFacet`
 * below, seeded from the room's own external.jsonl) and becomes its own
 * `edited` frame, same as a fresh import (records.mjs) — frames stay
 * append-only either way; nothing already on disk is ever rewritten. A
 * retrofit slice's own mark CANNOT reconnect to a facet from the room's
 * LIVE period (that period was never VEIL's to begin with) — such a mark
 * is simply not applicable here and is skipped, same as any mark whose
 * facet lies outside the kept history.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastFrameInfo } from "connectome-house/src/frames-io.mjs";
import { classifySpeechAuthor } from "./beings.mjs";
import { LOST, externalIdOf, kindOfMime } from "./records.mjs";
import { acquireImportLock, releaseImportLock } from "./room-shape.mjs";
import { appendSlice } from "./write.mjs";
import { stripAuthorPrefix } from "./facets.mjs";

/** @typedef {import("./streams.mjs").StreamGroup} StreamGroup */

/** a room's external.jsonl, once: the "<platform>:<message_id>" ids
 * already recorded (either direction — the dedupe set) and, per id, the
 * house seq that row landed at (to reconnect an OLD facet a new mark
 * might target). */
function readExternalRows(runDir) {
  const ids = new Set();
  const seqOf = new Map();
  const p = join(runDir, "external.jsonl");
  if (existsSync(p))
    for (const line of readFileSync(p, "utf8").trim().split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.platform && row.message_id) {
          const k = `${row.platform}:${row.message_id}`;
          ids.add(k);
          if (typeof row.seq === "number") seqOf.set(k, row.seq);
        }
      } catch {
        /* a truncated/corrupt row — never fatal */
      }
    }
  return { ids, seqOf };
}

/** maps a slice's new timeline (items + marks past `priorLastSeq`) into
 * house frames, in the SAME shape `records.mjs`'s `buildRoom` produces —
 * `houseSeqOfFacet` starts seeded with every OLD facet this slice's marks
 * (including edits) might target (reconnected by external id below), and
 * grows as new items are mapped, each at its predicted absolute seq
 * (`startSeq + i`). */
function mapSliceTimeline({
  timeline,
  identity,
  delivered,
  key,
  platform,
  houseId,
  houseSeqOfFacet,
  originAuthorName,
  startSeq,
  knownBeings = null,
}) {
  const frames = [];
  const externalLines = [];
  const newParticipants = [];
  let turn = 0;
  let reaches = 0;
  let scrubbed = 0;
  let firstT = null;
  let lastT = null;
  const push = (f) => {
    const seq = startSeq + frames.length;
    frames.push(f);
    firstT ??= f.t;
    lastT = f.t;
    return seq;
  };
  const join = (handle, kind, home, t) => {
    if (!handle || houseSeqOfFacet.has(`participant:${handle}`)) return;
    houseSeqOfFacet.set(`participant:${handle}`, -1); // a marker, not a facet seq — "already joined"
    newParticipants.push({ handle, home, joined_t: t, ...(kind === "resident" ? { kind } : {}), via: "import" });
    push({ t, type: "participant.joined", handle, ...(kind === "resident" ? { kind } : { kind: "human" }) });
  };
  const attach = (a, by, t, requestedBy) => {
    if (!a.blobId && !a.data) return;
    push({
      t,
      type: "media.attached",
      by,
      turn,
      path: a.blobId ? `blob/${a.blobId}` : "blob/pending",
      kind: kindOfMime(a.mime),
      seen_by_model: false,
      requested_by: requestedBy,
      mime: a.mime,
      _blob: { blobId: a.blobId, data: a.data, mime: a.mime, bytes: a.bytes },
    });
  };

  for (const step of timeline) {
    if (step.mark) {
      const m = step.mark;
      const target = houseSeqOfFacet.get(m.facetId);
      if (target === undefined || target < 0) continue; // an orphan mark — its facet is outside this room
      if (m.kind === "remove") {
        push({ t: m.t, type: "retracted", target, reason: "deleted" });
      } else if (m.kind === "hide") {
        const by = (m.reactors ?? []).map((r) => identity.human({ platform, id: r })).filter(Boolean);
        push({ t: m.t, type: "hidden", target, by, reason: "redacted" });
      } else if (m.kind === "edit") {
        if (typeof m.text !== "string") continue;
        const stripped = stripAuthorPrefix(m.text, originAuthorName.get(m.facetId) ?? null);
        const s = identity.scrubMentions(stripped);
        scrubbed += s.scrubbed;
        const editedAt = m.editedAt ?? m.t;
        push({ t: editedAt, type: "edited", target, text: s.text, edited_at: editedAt });
      }
      continue;
    }
    const it = step.item;
    if (it.kind === "message") {
      const by = (it.authorId ? identity.human({ platform: it.platform, id: it.authorId, display: it.authorName }) : null) ?? "unknown";
      join(by, "human", it.platform, it.t);
      turn += 1;
      const s = identity.scrubMentions(it.text);
      scrubbed += s.scrubbed;
      const external = { platform: it.platform, stream: key, message_id: externalIdOf(it, delivered), author_id: by };
      const seq = push({ t: it.t, type: "message", by, turn, text: s.text, external });
      houseSeqOfFacet.set(it.facetId, seq);
      originAuthorName.set(it.facetId, it.authorName ?? null);
      externalLines.push({ t: it.t, seq, ...external });
      for (const a of it.attachments) attach(a, by, it.t, "human");
    } else if (it.kind === "speech") {
      const cls = classifySpeechAuthor(knownBeings, it.agentName);
      if (cls.kind === "system") {
        // VEIL workflow-stream automation naming itself as speaker
        // (beings.mjs) — never a being nor a human: a house notice frame,
        // same shape as records.mjs's twin of this branch.
        const s = identity.scrubMentions(it.text);
        scrubbed += s.scrubbed;
        const external = { platform, stream: key, message_id: externalIdOf(it, delivered), author_id: "system" };
        const seq = push({ t: it.t, type: "house", note: "system", text: s.text, external });
        houseSeqOfFacet.set(it.facetId, seq);
        originAuthorName.set(it.facetId, null);
        externalLines.push({ t: it.t, seq, ...external });
      } else if (cls.kind === "being") {
        const by = identity.bot(cls.canonical);
        join(by, "resident", houseId, it.t);
        const s = identity.scrubMentions(it.text);
        scrubbed += s.scrubbed;
        const external = { platform, stream: key, message_id: externalIdOf(it, delivered), author_id: by };
        const seq = push({
          t: it.t,
          type: "speech",
          by,
          turn,
          ...(it.interim ? { delivered_mid_turn: true } : {}),
          _text: s.text,
          external,
        });
        houseSeqOfFacet.set(it.facetId, seq);
        originAuthorName.set(it.facetId, null);
        externalLines.push({ t: it.t, seq, ...external });
        for (const a of it.attachments) attach(a, by, it.t, "model");
      } else {
        // a HUMAN's typed message recorded as a speech facet (beings.mjs) —
        // the same `message` shape a slice's own inbound platform message
        // gets, attributed to the SAME handle as any message this person
        // already sent (records.mjs's twin of this branch has the same note).
        const by = identity.humanFromSpeechAuthor(platform, it.agentName);
        join(by, "human", platform, it.t);
        turn += 1;
        const s = identity.scrubMentions(it.text);
        scrubbed += s.scrubbed;
        const external = { platform, stream: key, message_id: externalIdOf(it, delivered), author_id: by };
        const seq = push({ t: it.t, type: "message", by, turn, text: s.text, external });
        houseSeqOfFacet.set(it.facetId, seq);
        originAuthorName.set(it.facetId, null);
        externalLines.push({ t: it.t, seq, ...external });
        for (const a of it.attachments) attach(a, by, it.t, "human");
      }
    } else if (it.kind === "action") {
      reaches += 1;
      push({ t: it.t, type: "reach", tool: it.toolName ?? "action", input: { parameters: it.parameters, text: it.text }, callId: it.actionId ?? it.facetId });
    } else if (it.kind === "action-result") {
      push({ t: it.t, type: "reach.result", callId: it.actionId ?? it.facetId, ok: true, _text: it.text });
    }
  }
  return { frames, externalLines, newParticipants, turns: turn, reaches, scrubbed, firstT, lastT };
}

/**
 * Appends the new tail of `group` to the room already imported for it —
 * or, when the room has no `imported` field at all (the retrofit case,
 * this module's own header), the WHOLE of `group`'s matching VEIL history,
 * as one slice landing after whatever the room already has live.
 * @param {{runsDir: string, stateDir: string, runId: string, group: StreamGroup,
 *   identity: ReturnType<import("./identity.mjs").makeIdentity>,
 *   delivered: Map<string, {platform: string, messageId: string|null}>,
 *   houseId: string, exportedT: string, knownBeings?: Map<string, string>|null}} args
 *   `knownBeings` (beings.mjs's `classifySpeechAuthor`): same gate as
 *   records.mjs's `buildRoom` — a speech facet's `agentName` outside it is
 *   a human, re-classed to a `message` frame; `"system"` is a house
 *   notice, never either; `null`/omitted -> every speech author is a being.
 * @returns {Promise<{applied: boolean, reason?: string, frames?: number,
 *   skippedIds?: number, house_first_seq?: number, house_last_seq?: number,
 *   retrofit?: boolean}>}
 */
export async function sliceRoom({
  runsDir,
  stateDir,
  runId,
  group,
  identity,
  delivered,
  houseId,
  exportedT,
  knownBeings = null,
}) {
  const runDir = join(runsDir, runId);
  const clsPath = join(runDir, "class.json");
  if (!existsSync(clsPath)) return { applied: false, reason: "no such room" };
  const cls = JSON.parse(readFileSync(clsPath, "utf8"));
  // a room with an `imported` object has been through this importer
  // before (cli.mjs's buildRoom, or an earlier slice); one with NO
  // `imported` field at all was minted live by the house's own seat and
  // never touched by this importer — the retrofit case (module header).
  // Either way, this room already exists — cli.mjs's own findRoom-backed
  // lookup found it before ever calling sliceRoom, so a retrofit NEVER
  // mints a second room for the stream; it only ever appends to this one.
  const priorImported = cls.imported && typeof cls.imported === "object" ? cls.imported : null;
  const retrofit = !priorImported;
  const priorLastSeq = retrofit ? -1 : priorImported.last_seq;
  const newItemsAll = group.items.filter((it) => it.veilSeq > priorLastSeq);
  const newMarksAll = group.marks.filter((m) => m.veilSeq > priorLastSeq);
  if (!newItemsAll.length && !newMarksAll.length) return { applied: false, reason: "nothing new" };

  const { type: lastType } = lastFrameInfo(join(runDir, "frames.jsonl"));
  if (lastType !== "rested" && lastType !== "aborted")
    return { applied: false, reason: `room is not at rest (last frame: ${lastType})` };

  const lockPath = acquireImportLock(runDir);
  if (!lockPath) return { applied: false, reason: "another import holds this room's lock" };
  try {
    const key = cls.room?.stream ?? priorImported?.stream ?? group.stream;
    const platform = cls.room?.platform ?? group.platform;
    const extIdOfGroupItem = (it) => `${it.kind === "speech" ? platform : it.platform}:${externalIdOf(it, delivered)}`;
    const { ids: seenIds, seqOf: oldBySeqId } = readExternalRows(runDir);

    // reconnect OLD facets a new mark (including a further edit) might
    // target: facetId -> house seq, and its original author name (for
    // stripping VEIL's baked-in `<authorName> ` prefix off a later edit).
    // For a retrofit room, `priorLastSeq` is -1, so no group item is "old"
    // here — a retrofit's own marks can only reconnect against a PRIOR
    // slice already appended by an earlier retrofit run (idempotency),
    // never against the room's lived (non-VEIL) period, which is correct:
    // a VEIL-sourced mark could never legitimately target a frame VEIL
    // never held.
    const houseSeqOfFacet = new Map();
    const originAuthorName = new Map();
    for (const it of group.items) {
      if (it.veilSeq > priorLastSeq) continue;
      const hseq = oldBySeqId.get(extIdOfGroupItem(it));
      if (hseq !== undefined) {
        houseSeqOfFacet.set(it.facetId, hseq);
        originAuthorName.set(it.facetId, it.kind === "message" ? (it.authorName ?? null) : null);
      }
    }
    for (const h of cls.beings ?? []) houseSeqOfFacet.set(`participant:${h}`, -1);
    for (const p of cls.participants ?? []) if (p.handle) houseSeqOfFacet.set(`participant:${p.handle}`, -1);

    let skippedIds = 0;
    const newItems = newItemsAll.filter((it) => {
      const dup = seenIds.has(extIdOfGroupItem(it));
      if (dup) skippedIds += 1;
      return !dup;
    });
    if (!newItems.length && !newMarksAll.length)
      return { applied: false, reason: "nothing new after dedupe", skippedIds };

    const timeline = [];
    for (const m of newMarksAll) timeline.push({ at: m.veilSeq, mark: m });
    for (const it of newItems) timeline.push({ at: it.veilSeq, item: it });
    timeline.sort((a, b) => a.at - b.at);

    const startSeq = lastFrameInfo(join(runDir, "frames.jsonl")).seq + 2; // +1 past the closing frame, +1 for the leading late-slice marker
    const built = mapSliceTimeline({
      timeline,
      identity,
      delivered,
      key,
      platform,
      houseId,
      houseSeqOfFacet,
      originAuthorName,
      startSeq,
      knownBeings,
    });
    if (!built.frames.length) return { applied: false, reason: "nothing new after dedupe", skippedIds };

    const newVeilSeqs = [...newItems, ...newMarksAll].map((x) => x.veilSeq);
    const sliceFirstSeq = Math.min(...newVeilSeqs);
    const sliceLastSeq = Math.max(...newVeilSeqs);
    // the house range covers the WHOLE slice, bookends included: the
    // leading late-slice marker (startSeq - 1) through the trailing
    // closing frame (one past the last mapped item) — provenanceOfSeq
    // (a future life-entries.mjs reader) would read this range, and both
    // bookends are as much "this import" as the mapped items between them.
    const houseFirstSeq = startSeq - 1;
    const houseLastSeq = startSeq + built.frames.length;

    // K4: a late slice is accepted, never re-ordered — it lands AFTER the
    // frames already on disk regardless of VEIL seq order (retrofit: after
    // the room's ENTIRE live-recorded period); the house has no dedicated
    // "import slice" frame type, so this rides the generic `house` frame
    // (frame-schema.mjs's HouseFrame), tagged by `note`. `under_live: true`
    // only on a retrofit's own marker — a plain late-slice marker (a room
    // this importer already owned) carries no such flag.
    const sliceFrame = {
      t: exportedT,
      type: "house",
      note: "import-slice",
      source: "veil",
      stream: key,
      first_seq: sliceFirstSeq,
      last_seq: sliceLastSeq,
      exported_t: exportedT,
      ...(retrofit ? { under_live: true } : {}),
    };
    const allFrames = [sliceFrame, ...built.frames];
    const closing = { t: built.lastT ?? exportedT, type: "rested", turns: built.turns, reaches: built.reaches, notesFiled: [] };

    const clsPatch = (cls0) => {
      const prior0 = cls0.imported && typeof cls0.imported === "object" ? cls0.imported : null;
      return {
        ...cls0,
        imported: {
          source: "veil",
          stream: key,
          platform: prior0?.platform ?? platform,
          first_seq: prior0?.first_seq ?? sliceFirstSeq,
          last_seq: sliceLastSeq,
          ...(prior0?.buckets !== undefined ? { buckets: prior0.buckets } : {}),
          ...(prior0?.frames !== undefined ? { frames: prior0.frames } : {}),
          exported_t: prior0?.exported_t ?? exportedT,
          lost: prior0?.lost ?? LOST,
          ...(prior0 ? {} : { retrofit: true }),
          original_last_house_seq: prior0?.original_last_house_seq ?? (startSeq - 2),
          slices: [
            ...(prior0?.slices ?? []),
            {
              source: "veil",
              stream: key,
              first_seq: sliceFirstSeq,
              last_seq: sliceLastSeq,
              house_first_seq: houseFirstSeq,
              house_last_seq: houseLastSeq,
              exported_t: exportedT,
              ...(prior0 ? {} : { retrofit: true }),
            },
          ],
        },
        participants: [...(cls0.participants ?? []), ...built.newParticipants],
        beings: [...new Set([...(cls0.beings ?? []), ...built.newParticipants.filter((p) => p.kind === "resident").map((p) => p.handle)])].sort(),
      };
    };
    const runPatch = (run0) => ({
      ...run0,
      turns: (run0.turns ?? 0) + built.turns,
      reaches: (run0.reaches ?? 0) + built.reaches,
      state: "rested",
      sessions: [
        ...(run0.sessions ?? []),
        {
          imported: true,
          started: built.firstT ?? exportedT,
          ended: built.lastT ?? exportedT,
          usage: null,
          turns_at_end: (run0.turns ?? 0) + built.turns,
          reaches_at_end: (run0.reaches ?? 0) + built.reaches,
        },
      ],
    });

    const res = await appendSlice({ runsDir, stateDir, runId, frames: allFrames, closing, clsPatch, runPatch, externalLines: built.externalLines });
    return { applied: true, frames: res.frames, skippedIds, house_first_seq: houseFirstSeq, house_last_seq: houseLastSeq, retrofit };
  } finally {
    releaseImportLock(lockPath);
  }
}

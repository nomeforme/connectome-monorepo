// @ts-check
/* connectome-history-import/src/records.mjs — one stream group -> one house
 * room record, built in memory (frames in lived order, seq contiguous from
 * 0, class.json, run.json, the external.jsonl sidecar) and validated
 * against the house's own closed Frame schema (connectome-house/src/
 * frame-schema.mjs) before write.mjs puts a byte on disk.
 *
 * The mapping (docs/harness-port/04-history-restore.md §2): an event facet
 * -> a `message` entry, a speech facet -> a `speech` entry (cyclePending ->
 * `delivered_mid_turn`, NEVER the schema's own `interim` — that names a
 * different, house-side concept, a pre-tool fragment that was never
 * delivered at all; every VEIL speech facet reaching this importer WAS
 * delivered), an action pair -> a `reach`/`reach.result` pair, a substream
 * -> a forked room (a `room.mounted` frame's own `forkedFrom` pointer on
 * the child; write.mjs appends the matching `branch.created` marker to the
 * PARENT's own record), a deletion -> `retracted` (never the text), a 🫥 ->
 * `hidden` (who, not what — `target`, not VEIL's own facet id), and an
 * edit -> its OWN `edited` entry (target + final text + edited_at). This
 * last one differs from the private-harness source this was ported from,
 * which baked every edit into the original frame's own text in place
 * (its old `streams.mjs`'s `applyEdits`): the house's `Frame` schema
 * (frame-schema.mjs's `EditedFrame`) was added specifically so an edit can
 * be its OWN append instead, and doing that means a message edited more
 * than once is no longer lossy — every rewrite is its own `edited` frame,
 * not just the last one merged in.
 *
 * Attachments ride as `media.attached` pointing at the house blob root
 * (`blob/<sha>`); the bytes move in write.mjs.
 */
import { createHash } from "node:crypto";
import { stripAuthorPrefix } from "./facets.mjs";

export const LOST = [
  "replies", // reply/quote targets were never stored upstream (event-handler.ts:129-138, 196-206)
  "reactions", // every reaction but 🫥 was dropped at ingest (event-handler.ts:414-417)
  "typing", // typing indicators were events without facets
  "ambient", // veil:ambient nudges and bot-config facets — harness state, not the conversation
  "activations", // agent-activation / rendered-context facets — derived views of the same history
];

/** deterministic 4-char tail from the stream key — the house's own tail
 * is random (same-second mints apart); an import wants the same id twice. */
export const importTail = (key) =>
  createHash("sha256").update(`veil-import:${key}`).digest("hex").slice(0, 4);

/** the room's run id, in the house's own shape (serve-room-open.mjs's
 * `roomSlug` + serve-rooms.mjs's own id convention):
 * `room-<platform>-<slug8>-<stamp>-<4>`, stamped with the stream's FIRST
 * frame time so ids sort chronologically beside live ones. */
export function roomId({ platform, key, slug8, firstT }) {
  const stamp = String(firstT ?? new Date(0).toISOString())
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return `room-${platform}-${slug8}-${stamp}-${importTail(key)}`;
}

export const kindOfMime = (mime) => {
  const m = String(mime ?? "");
  return m.startsWith("image/")
    ? "image"
    : m.startsWith("audio/")
      ? "audio"
      : m.startsWith("video/")
        ? "video"
        : "other";
};

/** the external id an item is recorded under — a real platform message id
 * when there is one, else a PREFIXED stand-in that can never collide with
 * one: `veil-t:<iso>` for a message, `veil-facet:<id>` for undelivered
 * speech. Shared by a fresh import (below) and a later slice (slice.mjs),
 * so the same item always lands under the same id.
 * @param {import("./streams.mjs").StreamGroup["items"][number]} it
 * @param {Map<string, {platform: string, messageId: string|null}>} delivered
 * @returns {string|null} */
export function externalIdOf(it, delivered) {
  if (it.kind === "message") return it.messageId ?? `veil-t:${it.t}`;
  if (it.kind === "speech") return delivered.get(it.facetId)?.messageId ?? `veil-facet:${it.facetId}`;
  return null;
}

/** a public room is a guild channel anyone could read; everything else —
 * a Signal group or DM, a Discord DM, a web session — is the people's own. */
export function visibilityOf(platform, key) {
  if (platform === "discord" && !key.startsWith("discord:dm:")) return "public";
  return "private";
}

/**
 * @param {{
 *   group: import("./streams.mjs").StreamGroup, key: string, id: string,
 *   identity: ReturnType<import("./identity.mjs").makeIdentity>,
 *   delivered: Map<string, {platform: string, messageId: string|null}>,
 *   forkedFrom: {run: string, seq: number}|null, houseId: string, exportedT: string,
 *   substrate: string,
 * }} args
 */
export function buildRoom({
  group,
  key,
  id,
  identity,
  delivered,
  forkedFrom,
  houseId,
  exportedT,
  substrate,
}) {
  const g = group;
  const frames = [];
  const externalLines = [];
  const houseSeqOfFacet = new Map();
  // a facet's own author name (messages) or null (speech / unknown) — kept
  // so a LATER edit mark on the same facet can strip VEIL's baked-in
  // `<authorName> ` prefix the same way the original text was stripped.
  const originAuthorName = new Map();
  const veilToHouse = [];
  const participants = [];
  const seen = new Set();
  const speechCount = new Map();
  let turn = 0;
  let reaches = 0;
  let scrubbed = 0;
  let missingBlobs = 0;
  const firstT = g.firstT ?? exportedT;

  const push = (f) => {
    const frame = { seq: frames.length, ...f };
    frames.push(frame);
    return frame;
  };
  const join = (handle, kind, home, t) => {
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    participants.push({
      handle,
      home,
      joined_t: t,
      ...(kind === "resident" ? { kind } : {}),
      via: "import",
    });
    push({
      t,
      type: "participant.joined",
      handle,
      ...(kind === "resident" ? { kind } : { kind: "human" }),
    });
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

  for (const it of g.items) {
    if (it.kind === "speech")
      speechCount.set(it.agentName, (speechCount.get(it.agentName) ?? 0) + 1);
  }
  const bots = [...speechCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ({ name, handle: identity.bot(name) }));
  const primary = bots[0] ?? null;
  const walkers = bots.map((b) => ({ name: b.handle, model: b.name }));

  push({
    t: firstT,
    type: "room.mounted",
    platform: g.platform,
    substrate,
    run: id,
    ...(forkedFrom ? { forkedFrom } : {}),
    harness: {
      ...(primary ? { model: primary.name } : {}),
      ...(walkers.length ? { walkers } : {}),
    },
    imported: { source: "veil", stream: key, bucket_range: [g.firstSeq, g.lastSeq] },
  });

  // items, edits, hides and removes, all in ONE chronological timeline —
  // an edit is no longer pre-merged into its origin frame's own text (see
  // module header); it lands as its own `edited` append, in veilSeq order
  // alongside everything else.
  const timeline = [];
  for (const m of g.marks) timeline.push({ at: m.veilSeq, mark: m });
  for (const it of g.items) timeline.push({ at: it.veilSeq, item: it });
  timeline.sort((a, b) => a.at - b.at);

  for (const step of timeline) {
    if (step.mark) {
      const m = step.mark;
      const target = houseSeqOfFacet.get(m.facetId);
      if (target === undefined) continue; // a mark on a facet outside the kept history
      if (m.kind === "remove") {
        push({ t: m.t, type: "retracted", target, reason: "deleted" });
      } else if (m.kind === "hide") {
        const by = (m.reactors ?? [])
          .map((r) => identity.human({ platform: g.platform, id: r }))
          .filter(Boolean);
        push({ t: m.t, type: "hidden", target, by, reason: "redacted" });
      } else if (m.kind === "edit") {
        if (typeof m.text !== "string") continue; // only editedAt changed — nothing to record
        const stripped = stripAuthorPrefix(m.text, originAuthorName.get(m.facetId) ?? null);
        const s = identity.scrubMentions(stripped);
        scrubbed += s.scrubbed;
        const editedAt = m.editedAt ?? m.t;
        push({ t: editedAt, type: "edited", target, text: s.text, edited_at: editedAt });
      }
      veilToHouse.push([m.veilSeq, frames.length - 1]);
      continue;
    }
    const it = step.item;
    if (it.kind === "message") {
      const by =
        (it.authorId
          ? identity.human({ platform: it.platform, id: it.authorId, display: it.authorName })
          : null) ?? "unknown";
      join(by, "human", it.platform, it.t);
      turn += 1;
      const s = identity.scrubMentions(it.text);
      scrubbed += s.scrubbed;
      const external = {
        platform: it.platform,
        stream: key,
        message_id: externalIdOf(it, delivered),
        author_id: by,
      };
      const f = push({ t: it.t, type: "message", by, turn, text: s.text, external });
      houseSeqOfFacet.set(it.facetId, f.seq);
      originAuthorName.set(it.facetId, it.authorName ?? null);
      externalLines.push({ t: it.t, seq: f.seq, ...external });
      for (const a of it.attachments) attach(a, by, it.t, "human");
    } else if (it.kind === "speech") {
      const by = identity.bot(it.agentName);
      join(by, "resident", houseId, it.t);
      const s = identity.scrubMentions(it.text);
      scrubbed += s.scrubbed;
      const external = {
        platform: g.platform,
        stream: key,
        message_id: externalIdOf(it, delivered),
        author_id: by,
      };
      // VEIL's cyclePending marks a DELIVERED platform message whose agent
      // cycle went on (04-history-restore.md §2) — never the house's own
      // `interim` (a pre-tool fragment that was never delivered at all).
      const f = push({
        t: it.t,
        type: "speech",
        by,
        turn,
        ...(it.interim ? { delivered_mid_turn: true } : {}),
        _text: s.text,
        external,
      });
      houseSeqOfFacet.set(it.facetId, f.seq);
      originAuthorName.set(it.facetId, null);
      externalLines.push({ t: it.t, seq: f.seq, ...external });
      for (const a of it.attachments) attach(a, by, it.t, "model");
    } else if (it.kind === "action") {
      const callId = it.actionId ?? it.facetId;
      reaches += 1;
      push({
        t: it.t,
        type: "reach",
        tool: it.toolName ?? "action",
        input: { parameters: it.parameters, text: it.text },
        callId,
      });
    } else if (it.kind === "action-result") {
      const callId = it.actionId ?? it.facetId;
      push({ t: it.t, type: "reach.result", callId, ok: true, _text: it.text });
    }
    veilToHouse.push([it.veilSeq, frames.length - 1]);
  }
  for (const f of frames)
    if (f.type === "media.attached" && f._blob && !f._blob.blobId && !f._blob.data)
      missingBlobs += 1;

  const lastT = g.lastT ?? firstT;
  const title = identity.scrubTitle(g.title);
  const closing = { t: lastT, type: "rested", turns: turn, reaches, notesFiled: [] };
  const owner = primary?.handle ?? participants.find((p) => !p.kind)?.handle ?? "keeper";
  const ownerEntry = participants.find((p) => p.handle === owner);
  const visibility = visibilityOf(g.platform, key);
  const beings = participants
    .filter((p) => p.kind === "resident")
    .map((p) => p.handle)
    .sort();
  const cls = {
    // a generic marker only — room-policy.mjs's `carriesMemory` treats
    // anything but "sounding" as memory-bearing; the place (`room` below)
    // is what actually identifies this as a platform room.
    class: "room",
    live_origin: false,
    owner,
    owner_home: ownerEntry?.home ?? houseId,
    visibility,
    ...(primary ? { being: primary.handle } : {}),
    room: { platform: g.platform, stream: key, title: title ?? null, opened_t: firstT },
    ...(forkedFrom ? { forkedFrom } : {}),
    participants,
    beings,
    imported: {
      source: "veil",
      stream: key,
      platform: g.platform,
      first_seq: g.firstSeq,
      last_seq: g.lastSeq,
      buckets: g.buckets.size,
      frames: g.frames,
      exported_t: exportedT,
      lost: LOST,
    },
  };
  const run = {
    runId: id,
    born: firstT,
    ...(forkedFrom ? { forkedFrom } : {}),
    surface: null,
    model: primary?.name ?? null,
    ...(walkers.length ? { walkers: walkers.map((w) => ({ ...w, turns: speechCount.get(w.model) ?? 0, usage: null })) } : {}),
    thinking: null,
    turns: turn,
    reaches,
    filed: [],
    usage: null,
    state: "rested",
    sessions: [
      {
        imported: true,
        started: firstT,
        ended: lastT,
        usage: null,
        turns_at_end: turn,
        reaches_at_end: reaches,
      },
    ],
  };
  return {
    id,
    frames,
    closing,
    cls,
    run,
    externalLines,
    veilToHouse,
    stats: { scrubbed, missingBlobs, turns: turn, frames: frames.length + 1 },
  };
}

/** the parent's house seq a substream forks from: its last frame at or
 * before the child's first VEIL sequence (0 when the child predates it). */
export function forkSeqOf(parentVeilToHouse, childFirstSeq) {
  let seq = 0;
  for (const [v, h] of parentVeilToHouse) {
    if (v <= childFirstSeq) seq = h;
    else break;
  }
  return seq;
}

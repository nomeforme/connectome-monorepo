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
import { isKnownBeing } from "./beings.mjs";
import { stripAuthorPrefix } from "./facets.mjs";
import { LOST, externalIdOf, kindOfMime, visibilityOf } from "./room-shape.mjs";

export { LOST, importTail, roomId, kindOfMime, externalIdOf, visibilityOf } from "./room-shape.mjs";

/**
 * @param {{
 *   group: import("./streams.mjs").StreamGroup, key: string, id: string,
 *   identity: ReturnType<import("./identity.mjs").makeIdentity>,
 *   delivered: Map<string, {platform: string, messageId: string|null}>,
 *   forkedFrom: {run: string, seq: number}|null, houseId: string, exportedT: string,
 *   substrate: string, knownBeings?: Set<string>|null,
 * }} args `knownBeings`: a speech facet's `agentName` outside it is a
 *   HUMAN re-classed to a `message` frame (beings.mjs); `null`/omitted ->
 *   every speech author is a being (unchanged default).
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
  knownBeings = null,
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
  // a speech author outside `knownBeings`, re-classed to a human `message`
  // below — agentName -> {handle, count}, for the report's own section.
  const reclassed = new Map();
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
    if (it.kind === "speech" && isKnownBeing(knownBeings, it.agentName))
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
    } else if (it.kind === "speech" && isKnownBeing(knownBeings, it.agentName)) {
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
    } else if (it.kind === "speech") {
      // a HUMAN's typed message recorded as a speech facet (a substream or
      // workflow stream, `agentName` the human's own display handle, never
      // a being) — the SAME `message` shape an inbound platform message
      // gets. VEIL speech content carries no baked-in author prefix (only
      // event/message facets do), so `originAuthorName` stays null here,
      // same as a real being's speech.
      const by = identity.humanFromSpeechAuthor(g.platform, it.agentName);
      join(by, "human", g.platform, it.t);
      turn += 1;
      const s = identity.scrubMentions(it.text);
      scrubbed += s.scrubbed;
      const external = {
        platform: g.platform,
        stream: key,
        message_id: externalIdOf(it, delivered),
        author_id: by,
      };
      const f = push({ t: it.t, type: "message", by, turn, text: s.text, external });
      houseSeqOfFacet.set(it.facetId, f.seq);
      originAuthorName.set(it.facetId, null);
      externalLines.push({ t: it.t, seq: f.seq, ...external });
      for (const a of it.attachments) attach(a, by, it.t, "human");
      const r = reclassed.get(it.agentName) ?? { handle: by, count: 0 };
      r.count += 1;
      reclassed.set(it.agentName, r);
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
    stats: {
      scrubbed,
      missingBlobs,
      turns: turn,
      frames: frames.length + 1,
      reclassed: [...reclassed.entries()].map(([name, r]) => ({
        name,
        handle: r.handle,
        count: r.count,
      })),
    },
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

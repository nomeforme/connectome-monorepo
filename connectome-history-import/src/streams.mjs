// @ts-check
/* connectome-history-import/src/streams.mjs — the whole fleet history,
 * grouped by stream into the rooms the house will hold: one group per
 * streamId (`discord:<guild>:<channel>`, `signal:group:<id>`, `signal:dm:…`,
 * `web:…`, `substream:<name>`, …). Edits, deletions and 🫥 marks are keyed
 * by facet id, which is global — so they are collected once here and
 * resolved against whichever stream holds the facet. Substreams (a Discord
 * thread, a `!stream in <name>` fork) carry their parent from the
 * `stream:create`/`stream:join` events, and fork at the parent's last
 * frame before the substream's first.
 *
 * Ported (with adaptation) from a private deployment's own history importer
 * (2026-09-18): grouping is source-shaped, unchanged; `records.mjs` is where
 * a group's items/marks become house frames.
 */
import { isKnownBeing } from "./beings.mjs";

/** @typedef {import("./facets.mjs").MessageRecord} MessageRecord */
/** @typedef {import("./facets.mjs").SpeechRecord} SpeechRecord */

/**
 * @typedef {{
 *   stream: string, platform: string, title: string|null,
 *   parent: string|null, streamType: string|null,
 *   items: Array<MessageRecord|SpeechRecord|import("./facets.mjs").ActionRecord|import("./facets.mjs").ActionResultRecord>,
 *   marks: Array<{kind: "edit"|"hide"|"remove", facetId: string, t: string, veilSeq: number,
 *     text?: string|null, editedAt?: string|null, hidden?: boolean, reactors?: string[]}>,
 *   firstSeq: number, lastSeq: number, firstT: string|null, lastT: string|null,
 *   buckets: Set<string>, frames: number,
 * }} StreamGroup
 */

/** the platform a stream belongs to. A `substream:` fork takes its
 * platform from its parent (or from its messages' own `source`). */
export function platformOf(stream, parentPlatform, sources) {
  const head = String(stream).split(":")[0];
  if (head !== "substream") return head;
  if (parentPlatform) return parentPlatform;
  let best = null;
  let n = 0;
  for (const [k, v] of sources ?? []) if (v > n) [best, n] = [k, v];
  return best ?? "substream";
}

export function newGroup(stream) {
  return /** @type {StreamGroup} */ ({
    stream,
    platform: "",
    title: null,
    parent: null,
    streamType: null,
    items: [],
    marks: [],
    firstSeq: Number.POSITIVE_INFINITY,
    lastSeq: Number.NEGATIVE_INFINITY,
    firstT: null,
    lastT: null,
    buckets: new Set(),
    frames: 0,
  });
}

/** Collects the records of every frame into per-stream groups. Call
 * `add(records, bucketHash)` per frame, then `finish()` for the map. */
export function groupStreams() {
  /** @type {Map<string, StreamGroup>} */
  const groups = new Map();
  /** @type {Map<string, string>} facetId -> stream */
  const facetStream = new Map();
  /** @type {Map<string, {parent: string|null, streamType: string|null, title: string|null}>} */
  const streamMeta = new Map();
  /** @type {Map<string, Map<string, number>>} stream -> source -> count */
  const sources = new Map();
  /** @type {Map<string, {platform: string, messageId: string|null}>} speech facetId -> delivery */
  const delivered = new Map();
  /** @type {Map<string, {platform: string, id: string, username: string|null}>} */
  const mentions = new Map();
  /** @type {Array<{kind: "edit"|"hide"|"remove", facetId: string, t: string, veilSeq: number, text?: string|null, editedAt?: string|null, hidden?: boolean, reactors?: string[]}>} */
  const pendingMarks = [];

  const groupFor = (stream) => {
    let g = groups.get(stream);
    if (!g) {
      g = newGroup(stream);
      groups.set(stream, g);
    }
    return g;
  };

  const touch = (g, veilSeq, t, bucketHash) => {
    if (veilSeq < g.firstSeq) g.firstSeq = veilSeq;
    if (veilSeq > g.lastSeq) g.lastSeq = veilSeq;
    if (!g.firstT || t < g.firstT) g.firstT = t;
    if (!g.lastT || t > g.lastT) g.lastT = t;
    g.buckets.add(bucketHash);
    g.frames += 1;
  };

  function add(records, bucketHash) {
    for (const r of records) {
      switch (r.kind) {
        case "message":
        case "speech":
        case "action":
        case "action-result": {
          const g = groupFor(r.stream);
          g.items.push(r);
          facetStream.set(r.facetId, r.stream);
          touch(g, r.veilSeq, r.t, bucketHash);
          if (r.kind === "message") {
            const m = sources.get(r.stream) ?? new Map();
            m.set(r.platform, (m.get(r.platform) ?? 0) + 1);
            sources.set(r.stream, m);
            if (r.groupName && !g.title) g.title = r.groupName;
          }
          break;
        }
        case "edit":
        case "hide":
        case "remove":
          pendingMarks.push({ ...r, bucketHash });
          break;
        case "stream": {
          const prev = streamMeta.get(r.streamId) ?? {
            parent: null,
            streamType: null,
            title: null,
          };
          streamMeta.set(r.streamId, {
            parent: r.parentStreamId ?? prev.parent,
            streamType: r.streamType ?? prev.streamType,
            title: r.title ?? prev.title,
          });
          break;
        }
        case "delivered":
          delivered.set(r.facetId, { platform: r.platform, messageId: r.messageId });
          break;
        case "mention":
          if (!mentions.has(`${r.platform}:${r.id}`) || r.username)
            mentions.set(`${r.platform}:${r.id}`, {
              platform: r.platform,
              id: r.id,
              username: r.username,
            });
          break;
        default:
          break;
      }
    }
  }

  function finish() {
    for (const m of pendingMarks) {
      const stream = facetStream.get(m.facetId);
      if (!stream) continue; // a mark on a facet older than the kept history — nothing to mark
      const g = groupFor(stream);
      g.marks.push(m);
      g.buckets.add(m.bucketHash);
      if (m.veilSeq > g.lastSeq) g.lastSeq = m.veilSeq;
      if (!g.lastT || m.t > g.lastT) g.lastT = m.t;
    }
    for (const g of groups.values()) {
      const meta = streamMeta.get(g.stream);
      g.parent = meta?.parent && meta.parent !== g.stream ? meta.parent : null;
      g.streamType = meta?.streamType ?? null;
      if (!g.title) g.title = meta?.title ?? null;
      g.items.sort((a, b) => a.veilSeq - b.veilSeq || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      g.marks.sort((a, b) => a.veilSeq - b.veilSeq);
    }
    // platforms: parents first so a substream can inherit
    for (const g of groups.values())
      if (!g.stream.startsWith("substream:")) g.platform = platformOf(g.stream, null, null);
    for (const g of groups.values())
      if (g.stream.startsWith("substream:"))
        g.platform = platformOf(
          g.stream,
          g.parent ? groups.get(g.parent)?.platform : null,
          sources.get(g.stream),
        );
    return {
      groups,
      delivered,
      mentions,
      orphanMarks:
        pendingMarks.length - [...groups.values()].reduce((n, g) => n + g.marks.length, 0),
    };
  }

  return { add, finish };
}

/** per-stream counts for --dry-run and the report. `knownBeings` (see
 * beings.mjs): a speech item outside it counts as a human MESSAGE, not
 * bot speech — the same re-classing `records.mjs`'s `buildRoom` applies
 * on an actual write, so a dry run's counts already match what a real
 * run would produce. `null`/omitted -> every speech author is a being
 * (unchanged default). */
export function countGroup(g, knownBeings = null) {
  const c = {
    frames: g.frames,
    messages: 0,
    speech: 0,
    interim: 0,
    bots: new Set(),
    humans: new Set(),
    attachments: 0,
    edits: 0,
    deletions: 0,
    redactions: 0,
    actions: 0,
  };
  /** @type {Map<string, number>} agentName -> count, for the report's own
   * "speech authors re-classed as humans" section */
  const reclassed = new Map();
  for (const it of g.items) {
    if (it.kind === "message") {
      c.messages += 1;
      if (it.authorId) c.humans.add(it.authorId);
      c.attachments += it.attachments.length;
    } else if (it.kind === "speech" && isKnownBeing(knownBeings, it.agentName)) {
      c.speech += 1;
      if (it.interim) c.interim += 1;
      c.bots.add(it.agentName);
      c.attachments += it.attachments.length;
    } else if (it.kind === "speech") {
      c.messages += 1;
      c.humans.add(it.agentName);
      c.attachments += it.attachments.length;
      reclassed.set(it.agentName, (reclassed.get(it.agentName) ?? 0) + 1);
    } else c.actions += 1;
  }
  for (const m of g.marks) {
    if (m.kind === "edit") c.edits += 1;
    else if (m.kind === "remove") c.deletions += 1;
    else c.redactions += 1;
  }
  return {
    ...c,
    bots: c.bots.size,
    humans: c.humans.size,
    reclassed: [...reclassed.entries()].map(([name, count]) => ({ name, count })),
  };
}

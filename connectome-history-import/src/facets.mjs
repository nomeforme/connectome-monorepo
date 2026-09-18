// @ts-check
/* connectome-history-import/src/facets.mjs — one VEIL frame -> the records
 * this importer cares about, in a normalized shape that still carries the
 * RAW platform ids (identity.mjs is where those become handles; nothing
 * here is ever written to disk). Facet shapes per VEIL's own event handler
 * (connectome-ts/src/grpc/handlers/event-handler.ts): message facets
 * `:124-139`/`:191-207`/`:259-272`, edits `:147-163`/`:215-234`, deletions
 * `:166-175`/`:237-249`, speech `:346-368`, 🫥 `:398-511` (a rewriteFacet
 * carrying hiddenFromContext/hiddenReactors). Frames come in two kinds: an
 * event frame (the raw platform payload — read only for stream lineage and
 * speech-delivery aliases) and, a frame later, the delta frame that
 * adds/rewrites/removes the facet.
 *
 * Ported (with adaptation) from a private deployment's own history importer
 * (2026-09-18): this module's own VEIL-facet parsing is unchanged — the
 * source format doesn't vary with the target; only records.mjs/slice.mjs,
 * which turn these records into house frames, differ.
 */

/** VEIL bakes `<authorName> ` onto every message facet's content. Strip
 * exactly that prefix when the name is known, else any leading `<…> `. */
export function stripAuthorPrefix(content, name) {
  const c = String(content ?? "");
  if (name && c.startsWith(`<${name}> `)) return c.slice(name.length + 3);
  if (name && c === `<${name}>`) return "";
  return c.replace(/^<[^>\n]{0,120}> /, "");
}

/** ms-epoch, ISO string, or absent -> ISO string (or null) */
export function isoOf(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === "string" && ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** @typedef {{blobId?: string, contentType?: string, filename?: string, name?: string,
 *   size?: number, sizeBytes?: number, data?: string}} RawAttachment */

/** attachments as VEIL carried them (event: {id, contentType, size, blobId,
 * filename|name, url}; speech: {id, contentType, filename, sizeBytes,
 * blobId|data}) — `url` is dropped here (a platform CDN address). */
function attachmentsOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      blobId: typeof a.blobId === "string" ? a.blobId : null,
      mime: typeof a.contentType === "string" ? a.contentType : "application/octet-stream",
      filename:
        typeof a.filename === "string" ? a.filename : typeof a.name === "string" ? a.name : "",
      bytes:
        typeof a.size === "number" ? a.size : typeof a.sizeBytes === "number" ? a.sizeBytes : null,
      data: typeof a.data === "string" ? a.data : null,
    }));
}

/**
 * @typedef {{kind: "message", stream: string, facetId: string, platform: string,
 *   authorId: string|null, authorName: string|null, messageId: string|null,
 *   phoneShaped: boolean, botPhone: string|null, groupName: string|null,
 *   channelId: string|null, t: string, text: string, attachments: ReturnType<typeof attachmentsOf>,
 *   veilSeq: number}} MessageRecord
 * @typedef {{kind: "speech", stream: string, facetId: string, agentName: string,
 *   agentId: string|null, t: string, text: string, interim: boolean,
 *   attachments: ReturnType<typeof attachmentsOf>, veilSeq: number}} SpeechRecord
 * @typedef {{kind: "edit", facetId: string, text: string|null, editedAt: string|null, t: string, veilSeq: number}} EditRecord
 * @typedef {{kind: "hide", facetId: string, hidden: boolean, reactors: string[], t: string, veilSeq: number}} HideRecord
 * @typedef {{kind: "remove", facetId: string, t: string, veilSeq: number}} RemoveRecord
 * @typedef {{kind: "action", stream: string, facetId: string, actionId: string|null, toolName: string|null,
 *   parameters: unknown, text: string, agentName: string|null, t: string, veilSeq: number}} ActionRecord
 * @typedef {{kind: "action-result", stream: string, facetId: string, actionId: string|null, text: string, t: string, veilSeq: number}} ActionResultRecord
 * @typedef {{kind: "stream", streamId: string, parentStreamId: string|null, streamType: string|null,
 *   title: string|null, t: string, veilSeq: number}} StreamRecord
 * @typedef {{kind: "delivered", facetId: string, platform: string, messageId: string|null, veilSeq: number}} DeliveredRecord
 * @typedef {{kind: "mention", platform: string, id: string, username: string|null, veilSeq: number}} MentionRecord
 * @typedef {MessageRecord|SpeechRecord|EditRecord|HideRecord|RemoveRecord|ActionRecord|ActionResultRecord|StreamRecord|DeliveredRecord|MentionRecord} Record
 */

/** a Signal sender id may be the sender's phone number when no uuid was
 * known — the caller must never let it reach a record as-is. */
export const looksLikePhone = (s) => typeof s === "string" && /^\+?\d{7,15}$/.test(s);

/** a stream's human-readable title from the platform's own metadata
 * (a channel name, a group name) — never a person's name. */
function titleOf(meta) {
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.channelName === "string" && meta.channelName) return `#${meta.channelName}`;
  if (typeof meta.groupName === "string" && meta.groupName) return meta.groupName;
  if (typeof meta.name === "string" && meta.name) return meta.name;
  return null;
}

/** @param {any} frame @returns {Record[]} */
export function recordsOf(frame) {
  /** @type {Record[]} */
  const out = [];
  const veilSeq = Number(frame?.sequence);
  const frameT = isoOf(frame?.timestamp) ?? new Date(0).toISOString();
  const activeStream = frame?.activeStream?.streamId ?? null;

  for (const e of frame?.events ?? []) {
    const p = e?.payload ?? {};
    if (
      (e?.topic === "stream:create" || e?.topic === "stream:join") &&
      typeof p.streamId === "string"
    ) {
      out.push({
        kind: "stream",
        streamId: p.streamId,
        parentStreamId: typeof p.parentStreamId === "string" ? p.parentStreamId : null,
        streamType: typeof p.streamType === "string" ? p.streamType : null,
        title: titleOf(p.metadata),
        t: frameT,
        veilSeq,
      });
    } else if (e?.topic === "discord:message" && Array.isArray(p.mentions)) {
      // who a message @-mentioned, id + username: the only place a person
      // who never spoke gets a name the scrubber can map to a handle
      for (const m of p.mentions)
        if (m && typeof m === "object" && m.id != null)
          out.push({
            kind: "mention",
            platform: "discord",
            id: String(m.id),
            username: typeof m.username === "string" ? m.username : null,
            veilSeq,
          });
    } else if (e?.topic === "agent:speech:delivered" && typeof p.facetId === "string") {
      out.push({
        kind: "delivered",
        facetId: p.facetId,
        platform: String(p.platform ?? ""),
        messageId:
          p.platform === "discord" && p.platformMessageId != null
            ? String(p.platformMessageId)
            : p.platform === "signal" && p.timestamp != null
              ? String(p.timestamp)
              : null,
        veilSeq,
      });
    }
  }

  for (const d of frame?.deltas ?? []) {
    if (d?.type === "addFacet" && d.facet) {
      const f = d.facet;
      const st = f.state ?? {};
      const stream = typeof f.streamId === "string" ? f.streamId : activeStream;
      if (f.type === "event" && stream) {
        const source = String(st.source ?? String(st.eventType ?? "").split(":")[0] ?? "unknown");
        const authorName = st.authorName ?? st.senderName ?? null;
        const rawSender = st.authorId ?? st.senderId ?? null;
        out.push({
          kind: "message",
          stream,
          facetId: String(f.id),
          platform: source,
          authorId: rawSender != null ? String(rawSender) : null,
          authorName: authorName != null ? String(authorName) : null,
          messageId:
            st.messageId != null
              ? String(st.messageId)
              : st.timestamp != null
                ? String(st.timestamp)
                : null,
          phoneShaped: looksLikePhone(rawSender != null ? String(rawSender) : ""),
          botPhone: typeof st.botPhone === "string" ? st.botPhone : null,
          groupName: typeof st.groupName === "string" ? st.groupName : null,
          channelId: st.channelId != null ? String(st.channelId) : null,
          t: isoOf(st.timestamp) ?? frameT,
          text: stripAuthorPrefix(f.content, authorName),
          attachments: attachmentsOf(st.attachments),
          veilSeq,
        });
      } else if (f.type === "speech" && stream) {
        out.push({
          kind: "speech",
          stream,
          facetId: String(f.id),
          agentName: String(f.agentName ?? f.agentId ?? "bot"),
          agentId: f.agentId != null ? String(f.agentId) : null,
          t: isoOf(st.timestamp) ?? frameT,
          text: String(f.content ?? ""),
          interim: st.cyclePending === true,
          attachments: attachmentsOf(f.attachments),
          veilSeq,
        });
      } else if (f.type === "action" && stream) {
        out.push({
          kind: "action",
          stream,
          facetId: String(f.id),
          actionId: st.actionId != null ? String(st.actionId) : null,
          toolName: st.toolName != null ? String(st.toolName) : null,
          parameters: st.parameters ?? null,
          text: String(f.content ?? ""),
          agentName: f.agentName != null ? String(f.agentName) : null,
          t: frameT,
          veilSeq,
        });
      } else if (f.type === "action-result" && stream) {
        out.push({
          kind: "action-result",
          stream,
          facetId: String(f.id),
          actionId: st.actionId != null ? String(st.actionId) : null,
          text: String(f.content ?? ""),
          t: frameT,
          veilSeq,
        });
      }
    } else if (d?.type === "rewriteFacet" && typeof d.id === "string") {
      const ch = d.changes ?? {};
      const st = ch.state ?? {};
      if (typeof st.hiddenFromContext === "boolean" || Array.isArray(st.hiddenReactors)) {
        out.push({
          kind: "hide",
          facetId: d.id,
          hidden: st.hiddenFromContext === true,
          reactors: Array.isArray(st.hiddenReactors) ? st.hiddenReactors.map(String) : [],
          t: frameT,
          veilSeq,
        });
      } else if (typeof ch.content === "string" || st.editedAt != null) {
        out.push({
          kind: "edit",
          facetId: d.id,
          text: typeof ch.content === "string" ? ch.content : null,
          editedAt: isoOf(st.editedAt) ?? frameT,
          t: frameT,
          veilSeq,
        });
      }
    } else if (d?.type === "removeFacet" && typeof d.id === "string") {
      out.push({ kind: "remove", facetId: d.id, t: frameT, veilSeq });
    }
  }
  return out;
}

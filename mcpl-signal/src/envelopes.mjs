// @ts-check
/* mcpl-signal/src/envelopes.mjs — one signal-cli json-rpc envelope → one
 * house-neutral message, and that message → the two MCPL wire shapes
 * (`channels/incoming` for an open channel, `push/event` for addressed
 * traffic on a closed one). Pure: no wire, no I/O, no clock.
 *
 * The identity rule this file enforces: NO PHONE NUMBER LEAVES IT. A
 * sender is its Signal uuid; a sender known only by number becomes
 * sha256(number) hex — the same derivation the house's identity map
 * makes (`phoneId`), so the two sides agree without either seeing the
 * digits. A profile name that looks like a number is dropped. The raw
 * envelope (which carries `source`, `sourceNumber`, `account`) is read
 * here and nowhere else.
 *
 * Shapes read (from the fork's signal-websocket-receptor, ported as
 * rules): `dataMessage` {message, groupInfo{groupId,groupName}, mentions
 * [{uuid,start,length}], quote{id,authorUuid,author,text}, attachments
 * [{id,contentType,filename,size}], reaction{emoji,targetAuthorUuid,
 * targetSentTimestamp,isRemove}, remoteDelete{timestamp}};
 * `syncMessage.sentMessage` (the account's other devices —
 * `chat:from-self`); `editMessage{targetSentTimestamp,dataMessage}` (the
 * new content, mapped exactly like an ordinary message, tagged with the
 * message it replaces); `typingMessage`, `receiptMessage` (not forwarded
 * — no consumer yet). Mention placeholders are U+FFFC at UTF-16 offsets.
 * `remoteDelete` and `editMessage` both surface as a typed kind
 * ("deleted"/"edited") carrying `targetMessageId` — the id of the
 * message they act on — never as a silent skip. */
import { createHash } from "node:crypto";
import { MESSAGING } from "./manifest.mjs";

const PLACEHOLDER = "￼";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,}$/;

/** @param {unknown} s */
export const looksLikePhone = (s) => typeof s === "string" && PHONE_RE.test(s.trim());
/** sha256(number) hex — identical to the house identity map's phoneId */
export const phoneId = (n) => createHash("sha256").update(String(n)).digest("hex");
export const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);

/** uuid, else the number's digest, else null — never the number */
export function principalId(uuid, number) {
  if (isUuid(uuid)) return String(uuid).toLowerCase();
  if (number) return phoneId(number);
  return null;
}
export const groupChannelId = (gid) => `signal:group:${gid}`;
export const dmChannelId = (id) => `signal:dm:${id}`;
/** @param {string} id @returns {{kind:"group"|"dm", id: string}|null} */
export function parseChannelId(id) {
  const m = /^signal:(group|dm):(.+)$/.exec(String(id ?? ""));
  return m ? { kind: /** @type {"group"|"dm"} */ (m[1]), id: m[2] } : null;
}
/** the id a message carries to the host and back: author + Signal timestamp,
 * which is what a quote or reaction needs to name it */
export const messageIdOf = (authorId, ts) => `${authorId}:${ts}`;
/** @param {string} id @returns {{authorId: string, timestamp: number}|null} */
export function parseMessageId(id) {
  const m = /^(.+):(\d+)$/.exec(String(id ?? ""));
  return m ? { authorId: m[1], timestamp: Number(m[2]) } : null;
}

/** placeholders → `<@uuid>` (for the host's map) or `@name` (for prose) */
function replaceMentions(text, mentions, render) {
  let out = String(text ?? "");
  const sorted = [...mentions].sort((a, b) => b.start - a.start);
  for (const m of sorted) {
    if (!Number.isInteger(m.start) || !Number.isInteger(m.length)) continue;
    const at = out.slice(m.start, m.start + m.length);
    if (at !== PLACEHOLDER && at.length !== m.length) continue;
    out = out.slice(0, m.start) + render(m.uuid) + out.slice(m.start + m.length);
  }
  return out;
}

/**
 * @typedef {Object} Mapped
 * @property {"message"|"reaction"|"edited"|"deleted"|"skip"} kind
 * @property {string} [reason]
 * @property {string} [targetMessageId]  "edited"/"deleted" only: the message this event acts on
 * @property {string} channelId
 * @property {string|null} groupId
 * @property {string|null} groupName
 * @property {boolean} isDM
 * @property {{id: string, name: string|null}} author
 * @property {boolean} fromSelf
 * @property {number} timestamp
 * @property {string} messageId
 * @property {string} text  raw text with `<@uuid>` mention tokens
 * @property {string[]} mentions  uuids
 * @property {boolean} mentionsSelf
 * @property {{id: string|null, authorId: string|null, text: string|null}|null} quote
 * @property {boolean} quotesSelf
 * @property {{id: string|null, contentType: string, filename: string|null, size: number|null}[]} attachments
 * @property {boolean} dotPrefixed
 * @property {{emoji: string, remove: boolean, targetAuthorId: string, targetTimestamp: number}|null} reaction
 * @property {string|null} [number]  PRIVATE: the sender's number when the id is a digest — the server keeps it to answer, never forwards it
 */

/** @param {any} raw @param {{uuid: string|null, number: string}} self
 * @returns {Mapped|{kind:"skip", reason: string}} */
export function mapEnvelope(raw, self) {
  const env = raw?.envelope;
  if (!env || typeof env !== "object") return { kind: "skip", reason: "no-envelope" };
  const sent = env.syncMessage?.sentMessage;
  const edit = env.editMessage;
  const dm = edit?.dataMessage ?? env.dataMessage ?? sent;
  if (!dm) {
    if (env.typingMessage) return { kind: "skip", reason: "typing" };
    if (env.receiptMessage) return { kind: "skip", reason: "receipt" };
    return { kind: "skip", reason: "no-data" };
  }
  const remoteDelete = dm.remoteDelete;
  const fromSelf =
    !!sent || (!!self.uuid && env.sourceUuid === self.uuid) || env.sourceNumber === self.number;
  const authorId = fromSelf
    ? (self.uuid ?? phoneId(self.number))
    : principalId(env.sourceUuid, env.sourceNumber ?? env.source);
  if (!authorId) return { kind: "skip", reason: "no-sender" };
  const groupId = dm.groupInfo?.groupId ?? null;
  let channelId;
  if (groupId) channelId = groupChannelId(groupId);
  else if (sent) {
    const dest = principalId(sent.destinationUuid, sent.destinationNumber ?? sent.destination);
    if (!dest) return { kind: "skip", reason: "no-destination" };
    channelId = dmChannelId(dest);
  } else channelId = dmChannelId(authorId);
  const ts = Number(dm.timestamp ?? env.timestamp ?? 0);
  const base = {
    channelId,
    groupId,
    groupName: typeof dm.groupInfo?.groupName === "string" ? dm.groupInfo.groupName : null,
    isDM: !groupId,
    author: {
      id: authorId,
      name:
        !fromSelf && typeof env.sourceName === "string" && !looksLikePhone(env.sourceName)
          ? env.sourceName
          : null,
    },
    fromSelf,
    timestamp: ts,
    number: !fromSelf && !isUuid(env.sourceUuid) ? (env.sourceNumber ?? env.source ?? null) : null,
  };
  if (remoteDelete) {
    const targetTs = Number(remoteDelete.timestamp ?? 0);
    if (!targetTs) return { kind: "skip", reason: "delete-no-target" };
    return {
      kind: "deleted",
      ...base,
      messageId: messageIdOf(authorId, ts),
      targetMessageId: messageIdOf(authorId, targetTs),
      text: "",
      mentions: [],
      mentionsSelf: false,
      quote: null,
      quotesSelf: false,
      attachments: [],
      dotPrefixed: false,
      reaction: null,
    };
  }
  const r = dm.reaction;
  if (r?.emoji) {
    const targetAuthorId = principalId(r.targetAuthorUuid, r.targetAuthorNumber ?? r.targetAuthor);
    if (!targetAuthorId || !r.targetSentTimestamp)
      return { kind: "skip", reason: "reaction-target" };
    return {
      kind: "reaction",
      ...base,
      messageId: messageIdOf(authorId, ts),
      text: "",
      mentions: [],
      mentionsSelf: false,
      quote: null,
      quotesSelf: false,
      attachments: [],
      dotPrefixed: false,
      reaction: {
        emoji: String(r.emoji),
        remove: !!r.isRemove,
        targetAuthorId,
        targetTimestamp: Number(r.targetSentTimestamp),
      },
    };
  }
  const rawMentions = (Array.isArray(dm.mentions) ? dm.mentions : []).filter((m) =>
    isUuid(m?.uuid),
  );
  const mentions = [...new Set(rawMentions.map((m) => String(m.uuid).toLowerCase()))];
  const attachments = (Array.isArray(dm.attachments) ? dm.attachments : []).map((a) => ({
    id: a?.id != null ? String(a.id) : null,
    contentType: typeof a?.contentType === "string" ? a.contentType : "application/octet-stream",
    filename: typeof a?.filename === "string" ? a.filename : null,
    size: Number.isFinite(Number(a?.size)) ? Number(a.size) : null,
  }));
  const q = dm.quote;
  const quote = q
    ? {
        id: q.id != null ? String(q.id) : null,
        authorId: principalId(q.authorUuid, q.authorNumber ?? q.author),
        text: typeof q.text === "string" ? q.text : null,
      }
    : null;
  const text = String(dm.message ?? "");
  if (!text.trim() && !attachments.length && !mentions.length && !quote)
    return { kind: "skip", reason: groupId ? "group-update" : "contentless" };
  const selfId = self.uuid;
  const msg = {
    kind: /** @type {"message"|"edited"} */ ("message"),
    ...base,
    messageId: messageIdOf(authorId, ts),
    text: replaceMentions(text, rawMentions, (u) => `<@${String(u).toLowerCase()}>`),
    mentions,
    mentionsSelf: !!selfId && mentions.includes(selfId.toLowerCase()),
    quote,
    quotesSelf:
      !!quote?.authorId && (quote.authorId === selfId || quote.authorId === phoneId(self.number)),
    attachments,
    dotPrefixed: text.startsWith("."),
    reaction: null,
  };
  if (edit) {
    const targetTs = Number(edit.targetSentTimestamp ?? 0);
    if (!targetTs) return { kind: "skip", reason: "edit-no-target" };
    return { ...msg, kind: "edited", targetMessageId: messageIdOf(authorId, targetTs) };
  }
  return msg;
}

/** the `@name` prose rendering of a message's text
 * @param {Mapped} m @param {(uuid: string) => string|null} nameOf */
export function readableText(m, nameOf) {
  return m.text.replace(/<@([0-9a-f-]{36})>/g, (_s, u) => `@${nameOf(u) ?? u.slice(0, 8)}`);
}

/** tags per SPEC §16.2 — umbrellas emitted directly (addressed | ambient),
 * exactly one sender tag; Signal has no bot flag (see manifest.mjs)
 * @param {Mapped} m */
export function tagsFor(m) {
  const addressed = m.isDM || m.mentionsSelf || m.quotesSelf;
  const tags = [];
  if (m.mentionsSelf) tags.push("chat:mention");
  if (m.quotesSelf) tags.push("chat:reply");
  if (m.isDM) tags.push("chat:dm", "chat:private");
  else tags.push("chat:group");
  tags.push(addressed ? "chat:addressed" : "chat:ambient");
  tags.push(m.fromSelf ? "chat:from-self" : "chat:from-human");
  for (const a of m.attachments) {
    const ct = a.contentType;
    tags.push(
      ct.startsWith("image/")
        ? "chat:has-image"
        : ct.startsWith("audio/")
          ? "chat:has-audio"
          : "chat:has-file",
    );
  }
  return [...new Set(tags)];
}

/** a non-inlined attachment as one line of testimony (RFC-005's spirit:
 * a note, never a fetch on receipt) */
export function attachmentNote(a) {
  const size = a.size != null ? `${a.size} bytes` : "size unknown";
  return `[attachment: ${a.filename ?? a.id ?? "file"} (${a.contentType}, ${size}) — not inlined]`;
}

/** the content blocks: prose text (with the author prefix) then image
 * blocks / notes. `name` (RFC-005's own naming for the model-visible stub)
 * carries the attachment's own filename — Signal has one, unlike a bare
 * image block with no filename at all.
 * @param {Mapped} m @param {(uuid: string) => string|null} nameOf
 * @param {{data: string, mimeType: string, filename?: string|null, size?: number|null}[]} images
 * @param {number} textOffset */
export function contentFor(m, nameOf, images, textOffset = 0) {
  const body = readableText(m, nameOf).slice(textOffset);
  const prefix = m.author.name ? `${m.author.name}: ` : "";
  const blocks = [{ type: "text", text: `${prefix}${body}` }];
  for (const img of images)
    blocks.push({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
      name: img.filename ?? null,
      size: img.size ?? null,
    });
  for (const a of m.attachments) {
    if (a.contentType.startsWith("image/") && images.some((i) => i.id === a.id)) continue;
    blocks.push({ type: "text", text: attachmentNote(a) });
  }
  return blocks;
}

/** the envelope's own facts, verbatim under metadata/origin — ids only */
function facts(m, nameOf) {
  return {
    mentions: m.mentions,
    replyTo: m.quote?.id && m.quote.authorId ? messageIdOf(m.quote.authorId, m.quote.id) : null,
    replyToAuthorId: m.quote?.authorId ?? null,
    replyToAuthorName: m.quote?.authorId ? nameOf(m.quote.authorId) : null,
    rawContent: m.text,
    groupId: m.groupId,
    groupName: m.groupName,
    isMention: m.mentionsSelf,
    isReplyToBot: m.quotesSelf,
    isBot: false,
    isDM: m.isDM,
    isSelf: m.fromSelf,
  };
}

/** one channels/incoming message (SPEC §14.3) */
export function toIncoming(m, nameOf, images, textOffset = 0) {
  return {
    channelId: m.channelId,
    messageId: m.messageId,
    author: { id: m.author.id, name: m.author.name },
    timestamp: new Date(m.timestamp).toISOString(),
    content: contentFor(m, nameOf, images, textOffset),
    metadata: facts(m, nameOf),
    tags: tagsFor(m),
  };
}

/** push/event params (SPEC §9.2) */
export function toPush(m, nameOf, images, textOffset = 0) {
  return {
    featureSet: MESSAGING,
    eventId: `signal_msg_${m.messageId}`,
    timestamp: new Date(m.timestamp).toISOString(),
    origin: {
      source: "signal",
      messageId: m.messageId,
      channelId: m.channelId,
      mcplChannelId: m.channelId,
      authorId: m.author.id,
      authorName: m.author.name,
      ...facts(m, nameOf),
    },
    tags: tagsFor(m),
    payload: { content: contentFor(m, nameOf, images, textOffset) },
  };
}

/** an edit as push/event: the new content, tagged `chat:edited`, with
 * `targetMessageId` naming the message it replaces (SPEC §9.2 shape,
 * same content/tag machinery as an ordinary message)
 * @param {Mapped & {targetMessageId: string}} m */
export function toEditPush(m, nameOf, images, textOffset = 0) {
  return {
    featureSet: MESSAGING,
    eventId: `signal_edit_${m.messageId}`,
    timestamp: new Date(m.timestamp).toISOString(),
    origin: {
      source: "signal",
      messageId: m.messageId,
      targetMessageId: m.targetMessageId,
      channelId: m.channelId,
      mcplChannelId: m.channelId,
      authorId: m.author.id,
      authorName: m.author.name,
      ...facts(m, nameOf),
    },
    tags: [...tagsFor(m), "chat:edited"],
    payload: { content: contentFor(m, nameOf, images, textOffset) },
  };
}

/** a remote delete as push/event: no new content (Signal's remoteDelete
 * carries none) — just `targetMessageId`, tagged `chat:deleted`; the
 * house owns what "deleted" means (a tombstone, never a re-fetch of the
 * text), matching the reaction-hide seam's own division of labor
 * @param {Mapped & {targetMessageId: string}} m
 * @param {{uuid: string|null, number: string}} self */
export function toDeletePush(m, self) {
  const onOwn = m.author.id === self.uuid || m.author.id === phoneId(self.number);
  return {
    featureSet: MESSAGING,
    eventId: `signal_delete_${m.messageId}`,
    timestamp: new Date(m.timestamp).toISOString(),
    origin: {
      source: "signal",
      channelId: m.channelId,
      mcplChannelId: m.channelId,
      targetMessageId: m.targetMessageId,
      authorId: m.author.id,
      authorName: m.author.name,
      isDM: m.isDM,
      onOwnMessage: onOwn,
    },
    tags: [
      "chat:deleted",
      m.isDM ? "chat:dm" : "chat:group",
      m.fromSelf ? "chat:from-self" : "chat:from-human",
    ],
    payload: { content: [{ type: "text", text: "deleted a message" }] },
  };
}

/** a reaction as push/event — no `authorId` in origin (a host that wants
 * only messages ignores it, as the house does); `chat:to-self` when the
 * reacted-to message is this account's
 * @param {Mapped} m @param {{uuid: string|null, number: string}} self */
export function toReactionPush(m, self) {
  const r = /** @type {NonNullable<Mapped["reaction"]>} */ (m.reaction);
  const onOwn = r.targetAuthorId === self.uuid || r.targetAuthorId === phoneId(self.number);
  const tags = [r.remove ? "chat:reaction-remove" : "chat:reaction"];
  if (onOwn) tags.push("chat:to-self");
  return {
    featureSet: MESSAGING,
    eventId: `signal_react_${m.author.id}_${m.timestamp}`,
    timestamp: new Date(m.timestamp).toISOString(),
    origin: {
      source: "signal",
      channelId: m.channelId,
      mcplChannelId: m.channelId,
      messageId: messageIdOf(r.targetAuthorId, r.targetTimestamp),
      reactorId: m.author.id,
      reactorName: m.author.name,
      emoji: r.emoji,
      action: r.remove ? "remove" : "add",
      onOwnMessage: onOwn,
      isDM: m.isDM,
    },
    tags,
    payload: {
      content: [{ type: "text", text: `${r.remove ? "removed" : "reacted"} ${r.emoji}` }],
    },
  };
}

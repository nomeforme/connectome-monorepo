// @ts-check
/* harness/src/mcpl/normalize.mjs — the two server→host envelopes
 * (`push/event` with ids in `origin`; `channels/incoming` with ids in
 * `metadata`) folded into ONE IncomingMessage before the house sees
 * either (docs/research/mcpl.md §3.4, §4.3 "normalize once at the seat's
 * edge"): text blocks joined, image blocks kept as base64 + mime, tags
 * closure-expanded by the spec, the envelope's own fields carried
 * verbatim under `metadata` for whatever a platform adapter still needs.
 * Pure; no wire. */
import { expandTagClosure } from "./wire.mjs";

/** text of every text block, joined; images as {data, mimeType, name}.
 * `name` (RFC-005's own naming for the model-visible stub) is honestly
 * null when the platform's own block carries none — discord-mcpl's image
 * blocks never do; signal-mcpl's own do (envelopes.mjs's `contentFor`). */
function splitContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  const images = blocks
    .filter((b) => b && b.type === "image" && typeof b.data === "string")
    .map((b) => ({
      data: b.data,
      mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
      name: typeof b.name === "string" ? b.name : null,
    }));
  return { text, images, blocks };
}

/**
 * @typedef {Object} IncomingMessage
 * @property {"push"|"incoming"|"history"} envelope
 * @property {string} eventId
 * @property {string|null} messageId
 * @property {string|null} channelId
 * @property {string|null} threadId
 * @property {{id: string|null, name: string|null}} author
 * @property {string|null} timestamp
 * @property {string} text
 * @property {{data: string, mimeType: string, name: string|null}[]} images
 * @property {string[]} tags closure-expanded
 * @property {Record<string, any>} metadata the envelope's own fields, verbatim
 * @property {string[]} mentions platform ids
 * @property {string|null} replyTo
 * @property {string|null} replyToAuthorId
 * @property {string|null} rawContent
 * @property {boolean} isDM
 * @property {boolean} isBot
 */

/** push/event params → IncomingMessage (ids from `origin`)
 * @param {any} p @returns {IncomingMessage} */
export function normalizePush(p) {
  const o = p?.origin && typeof p.origin === "object" ? p.origin : {};
  const { text, images } = splitContent(p?.payload?.content);
  return {
    envelope: "push",
    eventId: String(p?.eventId ?? ""),
    messageId: o.messageId != null ? String(o.messageId) : null,
    channelId: o.mcplChannelId ?? o.channelId ?? null,
    threadId: o.threadId ?? null,
    author: { id: o.authorId != null ? String(o.authorId) : null, name: o.authorName ?? null },
    timestamp: p?.timestamp ?? null,
    text,
    images,
    tags: expandTagClosure(p?.tags),
    metadata: o,
    mentions: Array.isArray(o.mentions) ? o.mentions.map(String) : [],
    replyTo: o.replyTo != null ? String(o.replyTo) : null,
    replyToAuthorId: o.replyToAuthorId != null ? String(o.replyToAuthorId) : null,
    rawContent: typeof o.rawContent === "string" ? o.rawContent : null,
    isDM: !!o.isDM,
    isBot: !!o.isBot,
  };
}

/** one channels/incoming message → IncomingMessage (ids from `metadata`)
 * @param {any} m @param {"incoming"|"history"} [envelope]
 * @returns {IncomingMessage} */
export function normalizeIncoming(m, envelope = "incoming") {
  const md = m?.metadata && typeof m.metadata === "object" ? m.metadata : {};
  const { text, images } = splitContent(m?.content);
  return {
    envelope,
    eventId: String(m?.messageId ?? ""),
    messageId: m?.messageId != null ? String(m.messageId) : null,
    channelId: m?.channelId ?? null,
    threadId: m?.threadId ?? null,
    author: {
      id: m?.author?.id != null ? String(m.author.id) : null,
      name: m?.author?.name ?? null,
    },
    timestamp: m?.timestamp ?? null,
    text,
    images,
    tags: expandTagClosure(m?.tags),
    metadata: md,
    mentions: Array.isArray(md.mentions) ? md.mentions.map(String) : [],
    replyTo: md.replyTo != null ? String(md.replyTo) : null,
    replyToAuthorId: md.replyToAuthorId != null ? String(md.replyToAuthorId) : null,
    rawContent: typeof md.rawContent === "string" ? md.rawContent : null,
    isDM: !!md.isDM,
    isBot: !!md.isBot,
  };
}

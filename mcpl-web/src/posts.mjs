// @ts-check
/* mcpl-web/src/posts.mjs — pure mapping between the board's shapes and
 * MCPL's: a room → a channel descriptor (SPEC §14.2), a post →
 * `channels/incoming` / `push/event`, and outbound text → the board's
 * post body. Also the JSON-RPC error vocabulary (SPEC App. A, §14.6).
 *
 * Mentions, both ways. The board names principals by id
 * (`being:fable-5`, `human:<id>`) in a post's `mentions` and resolves
 * `@<display>` in text itself. Inbound, every `@<display>` this seat can
 * attribute to a mentioned id becomes `<@id>` in `rawContent`, so the
 * house rewrites it to the right handle — the prose block keeps the
 * text as posted. Outbound, the house writes `<@id>` for an identity it
 * can address here; that becomes `@<display>` (or the id's own name part
 * when no display is known) in the text, and the id rides in `mentions`. */

export const RPC = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  FEATURE_SET_NOT_ENABLED: -32001,
  CAPABILITY_DENIED: -32002,
  UNKNOWN_CHANNEL: -32023,
};

export class RpcError extends Error {
  /** @param {number} code @param {string} message @param {unknown} [data] */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** `web:<community>:<slug>` */
export const ROOM_ID_RE = /^web:([^:\s]+):(\S+)$/;
/** the house's outbound mention token for a principal id */
export const MENTION_TOKEN_RE = /<@!?([a-z]+:[A-Za-z0-9_.:-]+)>/g;

/** a hello room entry (an object, or a bare id) → a descriptor; null when not a room id
 * @param {any} room */
export function descriptorFor(room) {
  const id = typeof room === "string" ? room : String(room?.id ?? "");
  const m = ROOM_ID_RE.exec(id);
  if (!m) return null;
  const title = typeof room?.title === "string" && room.title.trim() ? room.title.trim() : null;
  const community = typeof room?.community === "string" && room.community ? room.community : m[1];
  return {
    id,
    type: "web",
    label: `${title ?? m[2]} (web)`,
    direction: "bidirectional",
    address: { kind: "room", community, slug: m[2] },
    metadata: {
      channelType: "channel",
      community,
      ...(title ? { roomTitle: title } : {}),
      ...(typeof room?.public === "boolean" ? { public: room.public } : {}),
    },
    initiallyOpen: false,
  };
}

/** `@Fable Five` as the board accepts it: case-insensitive, `_`/`-`/space between words
 * @param {string} display @returns {RegExp|null} */
function displayTokenRe(display) {
  const words = String(display ?? "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return null;
  return new RegExp(`@${words.join("[\\s_-]")}(?![\\w-])`, "gi");
}

/** a display name as one unbroken `@` token (the board's own grammar)
 * @param {string} display */
export function displayToken(display) {
  return String(display ?? "").trim().replace(/\s+/g, "_");
}

/** @param {any} post @param {{id: string}|null} self */
export function mentionsSelf(post, self) {
  return !!self && Array.isArray(post?.mentions) && post.mentions.map(String).includes(self.id);
}

/** the facts both envelopes share
 * @param {any} post
 * @param {{self: {id: string}|null, displays: Map<string, string>,
 *   replyAuthor: (postId: string) => string|null, roomTitle: string|null}} ctx */
export function mapPost(post, ctx) {
  const author = post?.author ?? {};
  const mentions = Array.isArray(post?.mentions) ? [...new Set(post.mentions.map(String))] : [];
  const text = String(post?.text ?? "");
  let rawContent = text;
  for (const id of mentions) {
    const re = displayTokenRe(ctx.displays.get(id) ?? "");
    if (re) rawContent = rawContent.replace(re, `<@${id}>`);
  }
  const replyTo = post?.reply_to != null ? String(post.reply_to) : null;
  const replyToAuthorId = replyTo ? ctx.replyAuthor(replyTo) : null;
  const isBot = author.kind !== "human";
  const mention = mentionsSelf(post, ctx.self);
  const toSelf = !!(ctx.self && replyToAuthorId === ctx.self.id);
  const tags = [isBot ? "chat:from-bot" : "chat:from-human"];
  if (mention) tags.push("chat:mention");
  if (replyTo) tags.push("chat:reply");
  if (toSelf) tags.push("chat:to-self");
  tags.push(mention || toSelf ? "chat:addressed" : "chat:ambient");
  const metadata = {
    channelType: "channel",
    isDM: false,
    isBot,
    authorKind: typeof author.kind === "string" ? author.kind : null,
    mentions,
    rawContent,
    replyTo,
    replyToAuthorId,
    ...(ctx.roomTitle ? { roomTitle: ctx.roomTitle } : {}),
  };
  return {
    channelId: String(post?.room ?? ""),
    messageId: String(post?.id ?? ""),
    author: {
      id: String(author.id ?? ""),
      name: typeof author.display === "string" ? author.display : null,
      display: typeof author.display === "string" ? author.display : null,
      kind: typeof author.kind === "string" ? author.kind : null,
    },
    timestamp:
      typeof post?.created_at === "string"
        ? post.created_at
        : new Date(Number.isFinite(post?.ts) ? post.ts : Date.now()).toISOString(),
    content: [{ type: "text", text }],
    metadata,
    tags,
    addressed: mention || toSelf,
  };
}

/** one `channels/incoming` message (ids in `metadata`) @param {ReturnType<typeof mapPost>} m */
export function toIncoming(m) {
  const { addressed: _a, ...msg } = m;
  return msg;
}

/** `push/event` params (ids in `origin`) @param {ReturnType<typeof mapPost>} m */
export function toPush(m) {
  return {
    featureSet: "web.messaging",
    eventId: `web_post_${m.messageId}`,
    timestamp: m.timestamp,
    origin: {
      source: "web",
      messageId: m.messageId,
      channelId: m.channelId,
      mcplChannelId: m.channelId,
      authorId: m.author.id,
      authorName: m.author.name,
      ...m.metadata,
    },
    tags: m.tags,
    payload: { content: m.content },
  };
}

/** how a principal is written in outbound text: `@<display>` (one token), or
 * the id's own name part when no display is known
 * @param {string} id @param {Map<string, string>} displays */
export function mentionText(id, displays) {
  const display = displays.get(id);
  return `@${display ? displayToken(display) : id.slice(id.indexOf(":") + 1)}`;
}

/** outbound: `<@id>` → `@<display>` in the text, the id into `mentions`
 * @param {string} text @param {Map<string, string>} displays
 * @returns {{text: string, mentions: string[]}} */
export function outbound(text, displays) {
  const mentions = [];
  const out = String(text ?? "").replace(MENTION_TOKEN_RE, (_m, id) => {
    if (!mentions.includes(id)) mentions.push(id);
    return mentionText(id, displays);
  });
  return { text: out, mentions };
}

/** split at `limit`: paragraphs, then lines, then a hard cut
 * @param {string} text @param {number} limit @returns {string[]} */
export function splitText(text, limit) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// @ts-check
/* harness/src/mcpl/adapters.mjs — the one seam between the generic seat
 * and what a platform's server does differently: the shape every adapter
 * fills, the generic rules (what the seat does for every platform), and
 * the registry `adapterFor(platform)`. route.mjs, host.mjs and config.mjs
 * dispatch through here and hold no platform knowledge of their own; the
 * platform modules (discord.mjs, signal.mjs) hold only what differs and
 * are composed here. An unregistered platform gets the generic adapter
 * under its own name — the seat never refuses a server for being new. */
import * as discord from "./discord.mjs";
import { normalizeIncoming } from "./normalize.mjs";
import { splitForPlatform } from "./outbound.mjs";
import * as signal from "./signal.mjs";
import { METHOD } from "./wire.mjs";

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/**
 * @typedef {Object} RoomDescriptor a room's platform-given naming facts, for
 *   `titleFor` — gathered from a live message (docs/research/mcpl.md §3.4's
 *   guildName/channelName/threadName/groupName, refreshed on every message
 *   so a rename is never stale) plus, for a DM, the caller's own identityFor
 *   answer for the sender (a DM's only other party — never a platform id or
 *   a human's real/display name).
 * @property {"dm"|"group"|"channel"} kind this platform's own roomKind(msg)
 * @property {string|null} serverName a Discord guild's own name
 * @property {string|null} channelName a Discord channel's / Signal group's own name
 * @property {string|null} threadName set only when the message sits inside a thread
 * @property {string|null} dmHandle the house handle of a DM's other party, or null
 */

/**
 * @typedef {Object} PlatformAdapter
 * @property {string} platform
 * @property {string} label the platform's human-facing noun ("Discord"), used
 *   in house notices so no caller branches on platform names
 * @property {(args: {channelId: string, messageId: string|null, text: string, canReply: boolean}) => {name: string, args: Record<string, unknown>}} bareReply
 *   the wire call for a bare, unrecorded reply (the identity gate's notices):
 *   a native reply when the message id is known and the server offers one,
 *   else a plain send
 * @property {(msg: IncomingMessage) => string|null} roomKey the room's stream key
 *   (the server's channel id, verbatim); null when the id is not this platform's shape
 * @property {(msg: IncomingMessage) => "dm"|"group"|"channel"} roomKind
 * @property {(msg: IncomingMessage) => {platform: string, id: string, display: string|null}} sender
 *   the fields identityFor wants
 * @property {(msg: IncomingMessage) => string} text the text the room sees, before
 *   mention tokens are rewritten
 * @property {(msg: IncomingMessage) => string[]} mentions platform ids the message
 *   mentions (tokens in the text ∪ the envelope's list)
 * @property {(text: string, resolveHandle: (id: string) => string) => string} rewriteMentions
 *   the platform's mention tokens → `@handle`, the house's own grammar
 * @property {(msg: IncomingMessage) => {messageId: string|null, authorId: string|null}|null} reply
 *   the message this one answers, or null
 * @property {(msg: IncomingMessage) => {bytes: Buffer, mime: string, filename: string|null}[]} blobs
 * @property {number} limit the platform's outbound length cap
 * @property {(history: unknown) => IncomingMessage[]} historyToKept a channels/open
 *   backscroll in the shape live traffic normalizes to
 * @property {(text: string) => string[]} split speech at `limit`
 * @property {(channelId: string, on: boolean) => {capability: string, method: string, params: Record<string, unknown>}} typing
 *   the wire call to start/stop a typing indicator — host.mjs sends it
 *   through `notifyIfGranted`, never straight to the wire
 * @property {boolean} replyThreading whether THIS platform's own fork actually
 *   threads a being's reply as a native platform reply/quote (with its
 *   ping behaviour) rather than a plain send — speak.mjs's own `useReply`
 *   gate reads this per-platform, never a single house-wide default; a
 *   platform whose fork never reply-threads sets `false` even when the
 *   server it talks to happens to expose a `reply_message`-shaped tool
 * @property {(id: string) => string} mentionToken the platform's own mention
 *   markup for a raw id — the outbound inverse of the inbound token regex
 * @property {(args: {being: string, displayName: string|null, roster: string[]}) => string|null} surface
 *   the platform section of a room's address (docs/construction/platform-reach/
 *   plan.md's "platform is always a disambiguation"): what this platform is,
 *   how the being appears there, its formatting conditions — null for no
 *   platform section at all (the generic default; a plain chat is unaffected)
 * @property {(msg: IncomingMessage, extra: {dmHandle: string|null}) => RoomDescriptor} roomDescriptor
 *   this platform's own naming facts for msg's room, pure (no I/O — a DM's
 *   `dmHandle` is injected by the caller, which alone may touch the identity map)
 * @property {(d: RoomDescriptor) => string|null} titleFor a room's title, this
 *   platform's own rule ("a room's title comes from the platform",
 *   platform-reach R2b) — null when the facts aren't known yet, so the
 *   caller keeps whatever title the room already has rather than guessing
 * @property {boolean} [dotOptOut] a leading "." keeps a line out of the room (outside DMs)
 * @property {string[]} defaultBeingTools this platform's own conservative
 *   read/look-up/react-shaped tool names, offered to a seated being
 *   (platform-reach R2d gap 1) when the servers file names no `being_tools`
 *   of its own — config.mjs's loadServersConfig falls back to this exactly
 *   as it already does for `limit`. Never the seat's own speech tools.
 */

/** the generic mention token: `<@id>` / `<@!id>`, any id charset */
const MENTION_TOKEN_RE = /<@!?([A-Za-z0-9_-]+)>/g;

/** dm | group | channel, from the flag, the tags, or the id's `:dm:` segment
 * @param {IncomingMessage} msg @returns {"dm"|"group"|"channel"} */
export function genericRoomKind(msg) {
  if (msg.isDM || msg.tags.includes("chat:dm") || /:dm:/.test(msg.channelId ?? "")) return "dm";
  if (msg.tags.includes("chat:group")) return "group";
  return "channel";
}

/** rawContent when the platform gives it, else the pre-rendered block
 * minus a `[#channel in server] ` header (the discord pin's own push/event
 * prose, live when `rawContent` is null — harness-port 28-reattach-gaps: a
 * frame like `[#general in <server>] user: @<display> hey`), a leading
 * `[replying to …]` line (the reply is carried structurally instead), and a
 * `username: ` prefix.
 * @param {IncomingMessage} msg */
export function genericText(msg) {
  if (msg.rawContent != null) {
    // rawContent is the sender's words alone; the server's lines about
    // what was attached (a note for a file it didn't fetch, a small text
    // file inlined) still belong to the message — save a note for a file
    // the house fetches itself, and an image's own label (both become a
    // media.attached frame with its own label)
    const extras = (msg.extras ?? []).filter((t) => !fetchableNote(t) && !/^\[image attachment: [^\]]*\]$/.test(t));
    return [msg.rawContent, ...extras].filter((t) => t !== "").join("\n");
  }
  let t = msg.text ?? "";
  t = t.replace(/^\[#[^\]]+ in [^\]]*\]\s*/, "");
  t = t.replace(/^\[replying to [^\]]*\]\n/, "");
  if (msg.author.name && t.startsWith(`${msg.author.name}: `))
    t = t.slice(msg.author.name.length + 2);
  return t;
}

/** whether `stream` — a room's own channel id, verbatim — names a DM on
 * `adapter`'s platform: the same `roomKind` rule a live message gets, fed
 * only the channelId (every registered adapter's own roomKind resolves
 * purely from the id's own grammar — parseChannelId, Signal's CHANNEL_RE —
 * never a live message's other fields). The one seam an outbound DM
 * decision goes through, so no call site string-matches `:dm:` itself.
 * @param {PlatformAdapter} adapter @param {string} stream @returns {boolean} */
export function isDMStream(adapter, stream) {
  const fake = /** @type {any} */ ({ channelId: stream, isDM: false, tags: [] });
  return adapter.roomKind(fake) === "dm";
}

/** the envelope's own list ∪ the mention tokens in the text (the two can
 * differ — a token the platform's renderer stripped, or an id-only
 * mention with no token in prose)
 * @param {RegExp} [re] the platform's token @returns {PlatformAdapter["mentions"]} */
export function mentionsWith(re = MENTION_TOKEN_RE) {
  return (msg) => {
    const out = [...msg.mentions];
    for (const m of String(msg.rawContent ?? msg.text ?? "").matchAll(re))
      if (!out.includes(m[1])) out.push(m[1]);
    return out;
  };
}

/** the platform's mention tokens → `@handle`
 * @param {RegExp} [re] @returns {PlatformAdapter["rewriteMentions"]} */
export function rewriteWith(re = MENTION_TOKEN_RE) {
  return (text, resolveHandle) =>
    String(text ?? "").replace(re, (_m, id) => `@${resolveHandle(id)}`);
}

/** @param {IncomingMessage} msg */
export function genericReply(msg) {
  return msg.replyTo ? { messageId: msg.replyTo, authorId: msg.replyToAuthorId ?? null } : null;
}

/** a platform's own CDN, the only place an attachment note's url is
 * fetched from (Discord's signed attachment urls) */
const FETCHABLE_HOST = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;

/** an attachment note the server left with a url instead of bytes (a PDF,
 * a doc, a too-large text file or image) → what the house fetches itself;
 * null for any other line.
 * @param {string} line @returns {{url: string, filename: string|null, mime: string|null}|null} */
export function fetchableNote(line) {
  const t = String(line ?? "");
  const url = /(https:\/\/\S+?)\]$/.exec(t)?.[1];
  if (!url || !FETCHABLE_HOST.test(url) || !/^\[(image )?attachment/.test(t)) return null;
  const filename = /^\[image attachment "([^"]+)"/.exec(t)?.[1] ?? /^\[attachment: (.+?)(?: \(| —)/.exec(t)?.[1] ?? null;
  const mime = /\(([a-z]+\/[a-z0-9.+-]+),/i.exec(t)?.[1]?.toLowerCase() ?? null;
  return { url, filename, mime };
}

/** every attachment the server handed over as bytes (image blocks, file
 * `resource` blocks), plus each one its notes name by a platform CDN url
 * — those carry `url` and are fetched by the seat before storing
 * @param {IncomingMessage} msg
 * @returns {{bytes?: Buffer, url?: string, mime: string|null, filename: string|null}[]} */
export function genericBlobs(msg) {
  return [
    ...msg.images.map((i) => ({ bytes: Buffer.from(i.data, "base64"), mime: i.mimeType, filename: i.name ?? null })),
    ...(msg.files ?? []).map((f) => ({ bytes: Buffer.from(f.data, "base64"), mime: f.mimeType, filename: f.name ?? null })),
    ...(msg.extras ?? []).map(fetchableNote).filter(Boolean).map((n) => ({ url: n.url, mime: n.mime, filename: n.filename })),
  ];
}

/** @param {unknown} history */
export function genericHistory(history) {
  return (Array.isArray(history) ? history : []).map((m) => normalizeIncoming(m, "history"));
}

/** a literal `@<displayName>` in text — how the record still names the
 * server's own bot when no `<@id>` token survived (a platform's own
 * cleanContent already resolved it, or the sender never made a real
 * mention entity at all): word-bounded and case-insensitive so a display
 * name inside a longer word is left alone. `displayName` unknown (null) is
 * a no-op — never guessed. @param {string} text
 * @param {string|null} displayName @param {string} handle @returns {string} */
export function rewriteSelfMention(text, displayName, handle) {
  if (!displayName) return String(text ?? "");
  const esc = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return String(text ?? "");
  return String(text ?? "").replace(new RegExp(`@${esc}(?![\\w-])`, "gi"), `@${handle}`);
}

/** the generic outbound mention token — `<@id>`, the same shape every
 * registered platform's own inbound regex matches, so a round trip is
 * consistent by default.
 * @type {PlatformAdapter["mentionToken"]} */
export function genericMentionToken(id) {
  return `<@${id}>`;
}

/** no platform section by default — an unregistered/mock platform (and,
 * structurally, a plain chat with no `--room` at all) carries no block;
 * a specific platform overrides this with its own conditions.
 * @type {PlatformAdapter["surface"]} */
export function genericSurface(_args) {
  return null;
}

/** no naming facts by default — an unregistered/mock platform computes no
 * title; the servers file's own title (an explicit override) or the room's
 * existing one carries it instead.
 * @type {PlatformAdapter["roomDescriptor"]} */
export function genericRoomDescriptor(msg, { dmHandle = null } = {}) {
  return {
    kind: genericRoomKind(msg),
    serverName: null,
    channelName: null,
    threadName: null,
    dmHandle,
  };
}

/** @type {PlatformAdapter["titleFor"]} */
export function genericTitleFor(_d) {
  return null;
}

/** the spec's own `channels/typing` (Host→Server, SPEC §14.1) fits every
 * registered platform so far — Discord's own indicator auto-expires and
 * ignores `op: "stop"`; ours reads `stop` for a real one. A future adapter
 * whose typing story differs overrides this.
 * @type {PlatformAdapter["typing"]} */
export function genericTyping(channelId, on = true) {
  return {
    capability: "channels.typing",
    method: METHOD.CHANNELS_TYPING,
    params: { channelId, op: on ? "start" : "stop" },
  };
}

/** the generic adapter under `platform`'s name: the server's channel id
 * verbatim as the room key, the generic rules for everything else; a
 * platform module overrides what differs
 * @param {string} platform
 * @param {{limit?: number, mentionTokenRe?: RegExp} & Partial<PlatformAdapter>} [overrides]
 * @returns {PlatformAdapter} */
export function genericAdapter(platform, { limit = 2000, mentionTokenRe, ...over } = {}) {
  return {
    platform,
    label: platform,
    bareReply: ({ channelId, messageId, text, canReply }) =>
      canReply && messageId
        ? { name: "reply_message", args: { channelId, messageId, content: text } }
        : { name: "send_message", args: { channelId, content: text } },
    roomKey: (msg) => msg.channelId || null,
    roomKind: genericRoomKind,
    sender: (msg) => ({
      platform,
      id: String(msg.author.id ?? ""),
      display: msg.author.name ?? null,
    }),
    text: genericText,
    mentions: mentionsWith(mentionTokenRe),
    rewriteMentions: rewriteWith(mentionTokenRe),
    reply: genericReply,
    blobs: genericBlobs,
    limit,
    historyToKept: genericHistory,
    split: (text) => splitForPlatform(text, limit),
    typing: genericTyping,
    mentionToken: genericMentionToken,
    surface: genericSurface,
    roomDescriptor: genericRoomDescriptor,
    titleFor: genericTitleFor,
    // an unregistered/mock platform offers a seated being no platform tools
    // at all — conservative-by-default extends to "none" here.
    defaultBeingTools: [],
    // conservative default: never assume a fork reply-threads just because
    // a server CAN — every registered platform below states its own,
    // cited, and a future platform module does the same rather than
    // inheriting a guess.
    replyThreading: false,
    ...over,
  };
}

/** Discord's own platform section — register per compose-surface.py's
 * `_held_surface_text` (a description of conditions, plainly stated, never
 * a persona). `displayName` unknown omits the "this account is named"
 * clause rather than guessing it. @type {PlatformAdapter["surface"]} */
function discordSurface({ being, displayName }) {
  const seenAs = displayName ? ` On Discord this account is named '${displayName}'.` : "";
  return [
    "## This room is on Discord",
    "",
    `In the house's records you are @${being}.${seenAs}`,
    "People appear by their house handle: a linked account's own handle, or",
    "a pseudonym the house keeps for someone not yet linked. To address",
    "someone write @handle — the house converts it. A message longer than",
    "2000 characters is split at paragraphs; Discord's markdown works;",
    "headings do not.",
  ].join("\n");
}

/** Signal's own platform section — no cleanContent rendering issue (a
 * mention always arrives as `<@uuid>`). The display-name clause states the
 * account's own profile name as a fact, exactly like Discord's, once one is
 * known (learned from a channels/open history entry, or the servers file's
 * own `display_name` — register.mjs sets the profile name but signal-mcpl
 * never reports it back over the wire, so this is otherwise the only way
 * the being learns it); unknown omits the clause rather than guessing.
 * @type {PlatformAdapter["surface"]} */
function signalSurface({ being, displayName }) {
  const seenAs = displayName ? ` On Signal this account is named '${displayName}'.` : "";
  return [
    "## This room is on Signal",
    "",
    `You are @${being}.${seenAs} Everyone here is named by @handle (people's handles`,
    "are pseudonyms the house keeps). To address someone write @handle —",
    "the house converts it. A message longer than 4096 characters is split",
    "at paragraphs; Signal carries plain text, no markdown.",
  ].join("\n");
}

/** Discord's title rule (a bare channel name reads as too generic on its
 * own): `<server> #<channel>`, `<server> #<parent> › <thread>` inside a
 * thread, `DM · @<handle>` for a DM — never a platform id or a human's
 * real name. Null when the facts aren't known yet (a message that arrived
 * before any name was learned) — the caller keeps the room's own title.
 * @param {RoomDescriptor} d @returns {string|null} */
function discordTitleFor(d) {
  if (d.kind === "dm") return d.dmHandle ? `DM · @${d.dmHandle}` : null;
  if (!d.serverName || !d.channelName) return null;
  return d.threadName
    ? `${d.serverName} #${d.channelName} › ${d.threadName}`
    : `${d.serverName} #${d.channelName}`;
}

/** Signal has no server, only the group's own name — "signal will only
 * have group name" (the keeper) — or a DM's handle.
 * @param {RoomDescriptor} d @returns {string|null} */
function signalTitleFor(d) {
  return d.kind === "dm" ? (d.dmHandle ? `DM · @${d.dmHandle}` : null) : (d.channelName ?? null);
}

export const discordAdapter = genericAdapter("discord", {
  label: "Discord",
  // "." opts a line out of the room (signal-mcpl does this server-side)
  dotOptOut: true,
  limit: discord.LIMIT,
  mentionTokenRe: discord.MENTION_TOKEN_RE,
  roomKey: discord.roomKey,
  roomKind: discord.roomKind,
  sender: discord.sender,
  roomDescriptor: discord.roomDescriptor,
  titleFor: discordTitleFor,
  surface: discordSurface,
  defaultBeingTools: discord.DEFAULT_BEING_TOOLS,
  // the keeper's UX (2026-09-19): an answer is a Discord reply to the
  // message that summoned it (discord-mcpl's `reply_message`), the way the
  // private harness already answers — a deliberate departure from the
  // fork's bare `channel.send` (O16), not parity with it.
  replyThreading: true,
});

export const signalAdapter = genericAdapter("signal", {
  label: "Signal",
  limit: signal.limit,
  mentionTokenRe: signal.MENTION_TOKEN_RE,
  roomKey: signal.roomKey,
  roomKind: signal.roomKind,
  sender: signal.sender,
  historyToKept: signal.historyToKept,
  roomDescriptor: signal.roomDescriptor,
  titleFor: signalTitleFor,
  surface: signalSurface,
  defaultBeingTools: signal.DEFAULT_BEING_TOOLS,
  // the keeper's UX (2026-09-19): a Signal answer quotes the message that
  // summoned it (mcpl-signal's `reply_message`), as the private harness does —
  // a named departure from the fork's live send path, which never quoted.
  replyThreading: true,
  // builder P-B, 2026-09-17: the fork's Signal side never sent an outbound
  // typing indicator (signal-afferent.ts's sendTypingIndicator was a
  // no-op) — signal.mjs's own `typing` returns a capability string that
  // structurally can never be granted, so this override (not the generic
  // channels.typing default) is what keeps the house from showing Signal
  // users a "typing…" indicator the fork's bot never showed.
  typing: signal.typing,
});

/** @type {Record<string, PlatformAdapter>} */
const REGISTRY = {
  discord: discordAdapter,
  signal: signalAdapter,
  mock: genericAdapter("mock"),
};

/** the adapter for a platform — registered, else the generic one under
 * that name. @param {string} platform @returns {PlatformAdapter} */
export function adapterFor(platform) {
  return REGISTRY[platform] ?? genericAdapter(platform);
}

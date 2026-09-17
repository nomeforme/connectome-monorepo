// @ts-check
/* harness/src/mcpl/discord.mjs — what is Discord-specific about a
 * discord-mcpl message, pure (docs/research/mcpl.md §3, §4.1): the
 * `discord:<guild>:<channel>` / `discord:dm:<channel>` id grammar
 * (`channels.ts:mcplChannelId` in the studied clone at `5fa3db9`), the
 * `<@id>` mention markdown, and the 2000-char cap. Everything else —
 * text, reply pairing off `replyTo`/`replyToAuthorId`, inline image
 * blocks, the `channels/open` history shape (plain `author: text` prose,
 * no rawContent/mentions/replyTo at this pin — read honestly as absent) —
 * is adapters.mjs's generic rule; adapters.mjs composes this module into
 * the `discord` adapter. */

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/** Discord's own outbound length cap. NOT the platform's raw 2000 (that IS
 * discord.js's own hard limit — the fork's own discord-axon splits at
 * 2000 straight against discord.js, matching it byte for byte), but the
 * real MCPL server this house actually talks to on sfo
 * (`@animalabs/discord-mcpl`, vendored to `mcpl-discord/node_modules` on
 * the deploy box) already splits server-side at 1900 inside its own
 * `send_message`/`reply_message`/`send_dm` tools (discord-adapter.ts:
 * 666, `splitForDiscord(text, limit = 1900)`) — and that tool call
 * returns only the LAST chunk's message id when it has to re-split
 * (server.ts's `sendMessage`, `lastId` is the sole id returned). A house
 * chunk over 1900 would silently become two real Discord messages while
 * the house's own external.jsonl still records one — breaking RX3 (🫥 on
 * a being's own message needs EVERY delivered chunk's id registered) and
 * doubling the splitting layer O13 asks to keep singular. 1900 is the
 * true operative cap for THIS deployment; kept here, named, rather than
 * inlined at the one call site (speak.mjs). KNOWN DRIFT (handoff, NO-
 * TOUCH for this task): adapters.mjs:265's `discordSurface()` hardcodes
 * the being's own self-description as "2000 characters is split..." —
 * that literal string doesn't read this constant, so it now
 * understates the true split point by 100 chars; whoever owns
 * adapters.mjs should update that prose to "1900" once this lands. */
export const LIMIT = 1900;

/** the one reaction with server-side meaning (02-user-contract.md §3,
 * RX1): U+1FAE5 "dotted line face" — added, the target message is
 * withdrawn from every being's rendered context; every reactor removed,
 * visible again (RX2). Every other emoji is decoded and, only in a
 * channel that opted into live reaction visibility at all (discord-
 * mcpl's own `set_reaction_visibility` tool — reaction pushes are OFF by
 * default there, server.ts:2447), enters as ordinary chat text — never
 * redaction (RX4/RX8). */
export const REDACT_EMOJI = "\u{1FAE5}"; // 🫥

/** discord-mcpl's own reaction push (server.ts:2616-2645) tags a reaction
 * `chat:reaction` (add) or `chat:reaction-remove` (remove) — SPEC §16.2's
 * own distinct pair, kept distinct on purpose upstream (collapsing them
 * broke "reactions to my messages" rules firing on un-reactions too,
 * their issue #14) — read here off `msg.tags` post-normalize.mjs.
 * @param {IncomingMessage} msg @returns {boolean} */
export function isReactionEvent(msg) {
  const tags = msg?.tags ?? [];
  return tags.includes("chat:reaction") || tags.includes("chat:reaction-remove");
}

/** the reaction a discord-mcpl push event carries, read off `origin`
 * (normalize.mjs's `metadata`, carried verbatim — server.ts:2625-2637's
 * own field names: `messageId`, `reactorId`, `reactorName`, `emoji`,
 * `action`). Null when `msg` isn't a reaction push at all.
 * @param {IncomingMessage} msg
 * @returns {{action: "add"|"remove", emoji: string, messageId: string|null,
 *   reactorId: string|null, reactorName: string|null}|null} */
export function reactionInfo(msg) {
  if (!isReactionEvent(msg)) return null;
  const md = msg?.metadata ?? {};
  return {
    action: (msg.tags ?? []).includes("chat:reaction-remove") ? "remove" : "add",
    emoji: typeof md.emoji === "string" ? md.emoji : "",
    messageId: md.messageId != null ? String(md.messageId) : null,
    reactorId: md.reactorId != null ? String(md.reactorId) : null,
    reactorName: typeof md.reactorName === "string" ? md.reactorName : null,
  };
}

/** @param {string} emoji @returns {boolean} */
export function isRedactReaction(emoji) {
  return emoji === REDACT_EMOJI;
}

/** discord-mcpl's own edit/delete push events (server.ts's onMessageEdit/
 * onMessageDelete handlers) carry no distinguishing tag at all and no
 * `messageId` in `origin` (only `channelId`) — a real gap in the
 * vendored server: the handler receives `messageId` as its own
 * parameter but never forwards it structurally over the wire, confirmed
 * reading `@animalabs/discord-mcpl`'s own `src/server.ts` on the deploy
 * box. The ONLY signal is this exact text template — the edit's own
 * `eventId` is `discord_edit_<messageId>` and the delete's payload text
 * IS `[message deleted] <messageId>` (the id verbatim, not embedded
 * elsewhere), so both are still recoverable without patching the
 * vendored package. Fragile on purpose named once, here, rather than
 * wherever a caller happens to read `msg.text` — a template wording
 * change upstream silently breaks this and nothing else should have to
 * notice. Until fixed upstream (recommended: the server should carry
 * `messageId` in `origin` for both), a router (NO-TOUCH for this task —
 * route.mjs's own job) reads this to build an `edited`/`retracted`
 * frame (frame-schema.mjs, this task).
 * @param {IncomingMessage} msg
 * @returns {{kind: "edit", text: string}
 *   | {kind: "delete", messageId: string}
 *   | null} */
const EDIT_NOTICE_RE = /^\[message edited\] ([\s\S]*)$/;
const DELETE_NOTICE_RE = /^\[message deleted\] (\S+)$/;
export function editOrDeleteNotice(msg) {
  const text = String(msg?.text ?? "");
  const edited = EDIT_NOTICE_RE.exec(text);
  if (edited) return { kind: "edit", text: edited[1] };
  const deleted = DELETE_NOTICE_RE.exec(text);
  if (deleted) return { kind: "delete", messageId: deleted[1] };
  return null;
}

/** harness-port R2-W, 2026-09-17 (02-user-contract.md O6): Discord's own
 * random-reply flavour — a room-wide lottery, never several beings
 * winning off one shared roll, AND the roll never fires at all once
 * another being in the room was targeted (mentioned/replied-to) by this
 * same message, even a being other than the one that would be rolling
 * (00-stack-as-is.md §4.2: "Discord's random roll only fires when no bot
 * was targeted at all"). route.mjs merges this into a being's own
 * covenant.dispatch ONLY where the covenant itself is silent — either
 * field set explicitly on a being's own covenant always wins. */
export const DISPATCH_DEFAULTS = {
  random_reply_suppressed_by_other_target: true,
  random_reply_single_winner: true,
};

/** the conservative default `being_tools` allowlist (platform-reach R2d gap
 * 1): read/look-up/react-shaped, each with a normalizer in
 * `mcpl/being-tools.mjs`'s registry (a tool with no registered normalizer is
 * never exposed, default or override). `send_message`/`reply_message`/
 * `send_dm` (speech), `edit_message`/`delete_message`/`delete_channel`/
 * `create_text_channel`/`filters_update` (mutating), and `fetch_history`/
 * `fetch_around`/`refresh_channels`/`mute_channel`/`unmute_channel`/
 * `set_reaction_visibility` (rich or account-settings shapes not yet
 * normalized) are all left out on purpose — a keeper override may name them
 * in the servers file, but the normalizer gate still refuses them until one
 * is written. */
export const DEFAULT_BEING_TOOLS = [
  "list_guilds",
  "list_channels",
  "list_channel_members",
  "list_emojis",
  "filters_get",
  "list_subscriptions",
  "channel_missed",
  "add_reaction",
  "remove_reaction",
];

/** Discord's mention markdown: `<@id>` or `<@!id>` (the `!` marks a
 * nickname-resolved ping in older clients; both resolve to the same id) */
export const MENTION_TOKEN_RE = /<@!?(\d+)>/g;

/** `discord:<guildId>:<channelId>` or `discord:dm:<channelId>` — the room
 * key IS this id, verbatim; nothing to derive beyond its own kind.
 * @param {string|null|undefined} channelId
 * @returns {{guildId: string, channelId: string, kind: "dm"|"channel"}|null} */
export function parseChannelId(channelId) {
  const parts = String(channelId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "discord" || !parts[1] || !parts[2]) return null;
  return { guildId: parts[1], channelId: parts[2], kind: parts[1] === "dm" ? "dm" : "channel" };
}

/** the channel id verbatim, or null when it is not discord-shaped
 * @param {IncomingMessage} msg @returns {string|null} */
export function roomKey(msg) {
  return parseChannelId(msg?.channelId) ? msg.channelId : null;
}

/** "dm" | "channel", from the id's own grammar (the precise parse; the
 * generic `:dm:` test is the fallback for a malformed id)
 * @param {IncomingMessage} msg @returns {"dm"|"channel"} */
export function roomKind(msg) {
  return parseChannelId(msg?.channelId)?.kind ?? (msg?.isDM ? "dm" : "channel");
}

/** the fields `identityFor` wants for this message's sender.
 * @param {IncomingMessage} msg
 * @returns {{platform: "discord", id: string, display: string|null}} */
export function sender(msg) {
  return {
    platform: "discord",
    id: String(msg?.author?.id ?? ""),
    display: msg?.author?.name ?? null,
  };
}

/** this message's own naming facts: guildName/channelName/threadName are
 * discord-mcpl's own live-rendered fields (docs/research/mcpl.md §3.4) —
 * read fresh off `message.channel`/`message.guild` on every event, so a
 * rename is never stale here even though the server's own cached channel
 * registry can be (a `channelUpdate` refreshes the server's descriptor
 * without re-announcing it — `registerAndNotifyNew`, discord-mcpl
 * `server.ts:2307-2323`). A DM has neither; its title rests on `dmHandle`
 * alone (the caller's own identityFor answer for the sender — a DM's only
 * other party, `chat:from-self` already filtered upstream).
 * @param {IncomingMessage} msg @param {{dmHandle?: string|null}} [extra]
 * @returns {import("./adapters.mjs").RoomDescriptor} */
export function roomDescriptor(msg, { dmHandle = null } = {}) {
  const md = msg?.metadata ?? {};
  return {
    kind: roomKind(msg),
    serverName: typeof md.guildName === "string" ? md.guildName : null,
    channelName: typeof md.channelName === "string" ? md.channelName : null,
    threadName: typeof md.threadName === "string" ? md.threadName : null,
    dmHandle,
  };
}

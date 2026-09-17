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

/** Discord's own outbound length cap (the platform rejects a longer send) */
export const LIMIT = 2000;

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

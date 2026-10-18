// @ts-check
/* connectome-house/src/mcpl/web.mjs — what is web-board-specific about an
 * mcpl-web message, pure (the web-board contract v0): the
 * `web:<community>:<slug>` room id grammar, principal ids as mention
 * tokens (`<@being:fable-5>`, `<@human:<id>>` — the id carries a colon,
 * which the generic token grammar does not), the board's 8000-character
 * cap, and no history (mcpl-web returns none on `channels/open`; the house
 * keeps its own record). Everything else — text off `rawContent`, the
 * reply off `replyTo`/`replyToAuthorId`, the sender as identityFor wants
 * it — is adapters.mjs's generic rule; adapters.mjs composes this module
 * into the `web` adapter.
 *
 * The identity rule: a sender is its board principal id, verbatim
 * (`human:<id>`, `agent:<id>`, `being:<id>`), its display the board's
 * display name. mcpl-web announces the being's own principal as
 * `self.id` (serverInfo.self / channels/self), so the seat christens it
 * like Discord's being-hosted `self.id` (room-tails.mjs's
 * createSelfTracker) and a mention of that id wakes the being. */

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/** the board's own hard cap on a post (contract v0) */
export const LIMIT = 8000;

/** every board room faces people outside the house (contract v0: web
 * seats are `audience: "external"`) @type {"external"} */
export const AUDIENCE = "external";

/** mcpl-web's being tools: 🫥 / other reactions on a post, a flag (counted
 * once per being toward the board's threshold), and opening, archiving and
 * reopening rooms (beings only, capped by the board). Never the seat's own
 * speech tools. */
export const DEFAULT_BEING_TOOLS = ["add_reaction", "remove_reaction", "flag_post", "open_room", "close_room", "reopen_room"];

/** the board's own verdict, as mcpl-web forwards it: a 🫥 reaction push
 * whose `origin.moderationCause` is "flags" (with `flagCount` and the
 * post author's display) — the one case that leaves a line in the room.
 * A 🫥-by-reaction hide says nothing, as on Signal and Discord. Never the
 * post's text (the push carries none).
 * @param {IncomingMessage} msg @returns {string|null} */
export function redactNote(msg) {
  const md = msg?.metadata ?? {};
  if (md.moderationCause !== "flags") return null;
  const n = Number.isInteger(md.flagCount) && md.flagCount > 0 ? md.flagCount : null;
  const display =
    typeof md.postAuthorDisplay === "string"
      ? md.postAuthorDisplay.replace(/[\s\u0000-\u001f[\]]+/g, " ").trim().slice(0, 64)
      : "";
  const who = display ? `a post by @${display.replace(/ /g, "_")}` : "a post";
  const after = n ? ` after ${n} flag${n === 1 ? "" : "s"}` : " after flags";
  return `[${who} was removed from the board${after}]`;
}

const ROOM_RE = /^web:([^:\s]+):(\S+)$/;
/** `<@kind:id>` — a board principal id inside the house's mention token */
export const MENTION_TOKEN_RE = /<@!?([a-z]+:[A-Za-z0-9_.:-]+)>/g;

/** the server's room id verbatim; anything else is not a web stream
 * @param {IncomingMessage} msg @returns {string|null} */
export function roomKey(msg) {
  return msg.channelId && ROOM_RE.test(msg.channelId) ? msg.channelId : null;
}

/** every board room is a shared room — the board has no DMs (contract v0)
 * @param {IncomingMessage} _msg @returns {"channel"} */
export function roomKind(_msg) {
  return "channel";
}

/** @param {IncomingMessage} msg */
export function sender(msg) {
  return { platform: "web", id: msg.author.id ?? "", display: msg.author.name ?? null };
}

/** none kept: mcpl-web answers `channels/open` without history
 * @param {unknown} _history @returns {IncomingMessage[]} */
export function historyToKept(_history) {
  return [];
}

/** the room's own title (mcpl-web carries `metadata.roomTitle` on every
 * post) and its community (the id's own first segment)
 * @param {IncomingMessage} msg @param {{dmHandle?: string|null}} [extra]
 * @returns {import("./adapters.mjs").RoomDescriptor} */
export function roomDescriptor(msg, { dmHandle = null } = {}) {
  const md = msg?.metadata ?? {};
  const m = ROOM_RE.exec(msg?.channelId ?? "");
  return {
    kind: "channel",
    serverName: m ? m[1] : null,
    channelName: typeof md.roomTitle === "string" && md.roomTitle ? md.roomTitle : null,
    threadName: null,
    dmHandle,
  };
}

/** `<community> #<room title>`; null until the title is known
 * @param {import("./adapters.mjs").RoomDescriptor} d @returns {string|null} */
export function titleFor(d) {
  if (!d.channelName) return null;
  return d.serverName ? `${d.serverName} #${d.channelName}` : d.channelName;
}

/** the platform section of a room's address: what the board is and how
 * the being appears there — conditions, plainly stated
 * @type {import("./adapters.mjs").PlatformAdapter["surface"]} */
export function surface({ being, displayName }) {
  const seenAs = displayName ? ` On the board this account is named '${displayName}'.` : "";
  return [
    "## This room is on the web board",
    "",
    `You are @${being}.${seenAs} People are named by @handle; to address`,
    "someone write @handle — the house converts it. A message longer than",
    "8000 characters is split at paragraphs; the board carries plain text.",
  ].join("\n");
}

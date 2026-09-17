// @ts-check
/* harness/src/mcpl/signal.mjs — what is Signal-specific about a
 * signal-mcpl message, pure: the `signal:group:<id>` / `signal:dm:<uuid>`
 * id grammar, `<@uuid>` mention tokens, the cap, and no history (Signal
 * has none). Everything else — text, the quote as the reply, inline image
 * blocks — is adapters.mjs's generic rule; adapters.mjs composes this
 * module into the `signal` adapter.
 *
 * The identity rule, stated once: signal-mcpl NEVER puts a phone number
 * on the wire. A sender is its Signal uuid; a sender known only by number
 * arrives as sha256(number) hex — the same derivation `identity-map.mjs`'s
 * `phoneId` makes — so `sender()` passes the id straight through and this
 * adapter has no number to hide. A display name that looks like a number
 * was already dropped server-side; `identityFor` drops one again. */

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/** Signal's own hard cap is 4096; this keeps a margin */
export const SIGNAL_LIMIT = 4000;
export const limit = SIGNAL_LIMIT;

/** the conservative default `being_tools` allowlist (platform-reach R2d gap
 * 1): both of this server's own non-speech tools, each with a normalizer in
 * `mcpl/being-tools.mjs`'s registry — `send_message`/`reply_message` (the
 * seat's own speech) are never offered. */
export const DEFAULT_BEING_TOOLS = ["list_groups", "add_reaction"];
const CHANNEL_RE = /^signal:(group|dm):(.+)$/;
export const MENTION_TOKEN_RE = /<@([0-9a-f-]{36})>/g;

/** the server's channel id verbatim (`signal:group:<id>` or
 * `signal:dm:<uuid|digest>`); anything else is not a Signal stream
 * @param {IncomingMessage} msg @returns {string|null} */
export function roomKey(msg) {
  return msg.channelId && CHANNEL_RE.test(msg.channelId) ? msg.channelId : null;
}

/** dm | group, from the channel id (the server tags `chat:group`/`chat:dm` too)
 * @param {string} stream */
export function kindOf(stream) {
  const m = CHANNEL_RE.exec(stream);
  return m?.[1] === "dm" ? "dm" : "group";
}

/** @param {IncomingMessage} msg @returns {"dm"|"group"} */
export function roomKind(msg) {
  return kindOf(msg.channelId ?? "");
}

/** the identityFor argument: the uuid or digest as given, the profile
 * name as display — never a number (see the header)
 * @param {IncomingMessage} msg */
export function sender(msg) {
  return { platform: "signal", id: msg.author.id ?? "", display: msg.author.name ?? null };
}

/** Signal has no history API — a `channels/open` returns none, and there
 * is nothing to keep; honest empty
 * @param {unknown} _history @returns {IncomingMessage[]} */
export function historyToKept(_history) {
  return [];
}

/** this message's own naming fact: the group's own name, carried verbatim
 * in every envelope's metadata (signal-mcpl's envelopes.mjs `facts()` —
 * backfilled server-side from signal-cli's `listGroups` when an envelope
 * omits it, `mcpl-servers/signal/src/server.mjs`). A DM has none; its title
 * rests on `dmHandle` alone (the caller's own identityFor answer for the
 * sender, a DM's only other party).
 * @param {IncomingMessage} msg @param {{dmHandle?: string|null}} [extra]
 * @returns {import("./adapters.mjs").RoomDescriptor} */
export function roomDescriptor(msg, { dmHandle = null } = {}) {
  const md = msg?.metadata ?? {};
  return {
    kind: roomKind(msg),
    serverName: null,
    channelName: typeof md.groupName === "string" ? md.groupName : null,
    threadName: null,
    dmHandle,
  };
}

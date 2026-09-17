// @ts-check
/* harness/src/mcpl/route.mjs — one normalized platform message → a list of
 * house ACTIONS, pure: no I/O, every lookup injected. The house's rules
 * decide; a server's tags are producer testimony, never authority (SPEC
 * §16.6): `chat:addressed` is a cross-check the record can keep, not the
 * decision — `decideActivation` (dispatch.mjs) is, once per being present,
 * against that being's posture in this room (resident-covenant.mjs's
 * roomPostureFor).
 *
 * The rules this file states (what a platform does differently — the id
 * grammar, mention tokens, the reply shape — is the platform's adapter,
 * adapters.mjs's `adapterFor(server.platform)`; this file reads through it):
 * - Room key = the server's channel id verbatim (`discord:<guild>:<chan>`,
 *   `signal:dm:<uuid>` — platform prefix from the server); DM/group/
 *   channel `kind` the adapter's. An unconfigured stream is ignored
 *   (keeper's rooms only); a configured stream that has no open room
 *   opens one first.
 * - Sender = identityFor at call time; a `chat:from-self` message never
 *   enters (the being's own words are already its speech in the record);
 *   a `chat:from-bot` sender enters as `kind:"resident"` when the house
 *   knows it as a being (a testament handle), else `kind:"walker"` — never
 *   as a human; humans are `kind:"human"`.
 * - Text = the adapter's (rawContent when the platform gives it, else the
 *   pre-rendered block minus its `username: ` prefix); mention tokens
 *   become `@handle` through the same identity map, so a platform mention
 *   of the being IS an @mention the house's grammar reads.
 * - Per being: activates → input carrying `targets` (the child runs a turn
 *   for exactly those beings) — a platform mention/reply/DM reaches a
 *   sleeping resident like an in-app visit (decideActivation, dispatch.mjs);
 *   sleep gates only the unaddressed paths. The `reason === "asleep" &&
 *   targets.includes(being)` receipt branch below is kept for what it once
 *   answered but is now structurally dead for platform rooms: `targets`
 *   only ever names a being decideActivation found addressed, and an
 *   addressed being no longer reads "asleep" — never delete without
 *   re-deriving this. Nobody activates → the message still enters, as
 *   input carrying `observe: true` (the record is the single copy of the
 *   room — every message enters it; a being answers only when the house's
 *   own decideActivation names it, via `roomInput`'s targets/observe wire
 *   into walk.mjs's `dispatch`).
 * - History (a channels/open backscroll) is kept by the host, not poured:
 *   the record schema has no provenance for imported lines (the importer
 *   owns that shape).
 * - Title = the servers file's own `title` (an explicit override — set
 *   wins) else the adapter's own `titleFor` of this message's naming facts
 *   (`roomDescriptor`) — carried on every action as `roomTitle` so seat.mjs
 *   can refresh `class.json.room.title` on the room's next open OR reopen,
 *   not only at mint ("a platform room's title comes from the platform",
 *   platform-reach R2b).
 * - A group/channel room is auth-gated by DEFAULT: an unlinked human sender
 *   (not the keeper) never activates a being there, `configured.public`
 *   unset or false — no decideActivation call at all, so no random-wake
 *   roll ever fires for it either. An addressed (mention/reply) message
 *   from such a sender also carries `input.notice: true` (seat.mjs replies
 *   with link.mjs's template); either way the message still enters the
 *   record, observe-only, same as any other unaddressed line. `public:
 *   true` on the room lifts the gate entirely — any sender activates, as
 *   before this field existed. DMs are untouched (mcpl/link.mjs's own
 *   pre-gate). */
import { decideActivation, mentionsIn } from "../dispatch.mjs";
import { adapterFor, rewriteSelfMention } from "./adapters.mjs";

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/**
 * @typedef {Object} RouteServer
 * @property {string} name
 * @property {string} platform
 * @property {string} being the handle this server's one bot identity speaks for
 * @property {string|null} [displayName] the platform's own rendered name for
 *   `being` (self-display.mjs's learned answer, or null when not yet known)
 * @property {{stream: string, title?: string|null, beings?: string[], public?: boolean}[]} rooms
 */
/**
 * @typedef {Object} RouteDeps
 * @property {RouteServer} server
 * @property {IncomingMessage} msg
 * @property {(stream: string) => {id: string, beings: string[], live: boolean}|null} roomsOpen
 * @property {(args: {platform: string, id: string, display?: string|null}) =>
 *   {handle: string, known: boolean, linked?: boolean}} identityFor
 * @property {(handle: string) => boolean} isBeing a testament-holding handle
 * @property {(handle: string, roomKey: string) => {posture: "resident"|"present", dispatch: Record<string, any>}} covenants
 * @property {(stream: string) => string} roomKeyOf the covenant's per-room key for a stream
 * @property {(handle: string) => boolean} awakeOf
 * @property {(stream: string) => number} [streakOf] bot-to-bot mention streak, the seat's counter
 * @property {(handle: string) => boolean} [isKeeper] holds the keeper role (users.json) — the
 *   only thing admitsUnlistedDM below checks; default: nobody
 * @property {() => number} [rng]
 * @property {import("./adapters.mjs").PlatformAdapter} [adapter] default: adapterFor(server.platform)
 */
/** @typedef {{kind: "ignore", reason: string}
 *   | {kind: "open-room", platform: string, stream: string, title: string|null, beings: string[]}
 *   | {kind: "share-blob", stream: string, by: string, bytes: Buffer, mime: string,
 *       filename: string|null, roomTitle: string|null}
 *   | {kind: "receipt", stream: string, being: string, by: string, roomTitle: string|null}
 *   | {kind: "input", stream: string, by: string, by_kind: "human"|"resident"|"walker",
 *       home: string, text: string, targets: string[], observe?: true, notice?: true,
 *       reasons: Record<string, string>, messageKind: "dm"|"group"|"channel",
 *       roomTitle: string|null,
 *       external: {platform: string, message_id: string|null,
 *       author: string, reply_to: string|null}}} RouteAction
 * `external` carries platform MESSAGE ids (room addresses) and the
 * sender's house handle — never the sender's platform id, which lives in
 * the identity map alone (identityMapReverse is the road back). `roomTitle`
 * is the SAME resolved value on every action of one call (open-room's own
 * `title` field carries it there instead) — seat.mjs reads whichever action
 * it hits first, since only one `ensureLive` call happens per message. */

/** an unconfigured/unopened stream is normally ignored outright (the rooms
 * allowlist, keeper's word: "no need to change that") — the one exception
 * is a DM (the adapter's own DM notion) from a sender who is either LINKED
 * (identity-map.mjs's `linked: true` — an app account explicitly connected
 * this platform id, via `harness/tools/identity.mjs link` or a redeemed
 * app connect code, `mcpl/link.mjs`) or holds the keeper role (kept as its
 * own check: real identity-map entries written before `linked` existed
 * still admit the keeper). One named predicate, read by BOTH the seat's
 * own DM pre-gate (`mcpl/link.mjs`'s `preConnectionReply`) and this file's
 * own admission decision below — a sender who reaches routeIncoming at
 * all for an unlisted DM has already passed this same check once.
 * @param {{messageKind: string, sender: {known: boolean, handle: string, linked?: boolean},
 *   isKeeper: (handle: string) => boolean}} args
 * @returns {boolean} */
export function admitsUnlistedDM({ messageKind, sender, isKeeper }) {
  return (
    messageKind === "dm" && sender.known && (sender.linked === true || isKeeper(sender.handle))
  );
}

/**
 * @param {RouteDeps} deps
 * @returns {RouteAction[]} */
export function routeIncoming({
  server,
  msg,
  roomsOpen,
  identityFor,
  isBeing,
  covenants,
  roomKeyOf,
  awakeOf,
  streakOf = () => 0,
  isKeeper = () => false,
  rng,
  adapter = adapterFor(server.platform),
}) {
  if (msg.envelope === "history") return [{ kind: "ignore", reason: "history-kept" }];
  if (msg.tags.includes("chat:from-self")) return [{ kind: "ignore", reason: "from-self" }];
  const stream = adapter.roomKey(msg);
  if (!stream) return [{ kind: "ignore", reason: "no-channel" }];
  if (!msg.author.id) return [{ kind: "ignore", reason: "no-author" }];

  const configured = server.rooms.find((r) => r.stream === stream) ?? null;
  const open = roomsOpen(stream);
  const sender = identityFor(adapter.sender(msg));
  const messageKind = adapter.roomKind(msg);
  if (!configured && !open && !admitsUnlistedDM({ messageKind, sender, isKeeper }))
    return [{ kind: "ignore", reason: "unconfigured" }];
  const beings = open?.beings?.length
    ? open.beings
    : configured?.beings?.length
      ? configured.beings
      : [server.being];
  const roomKey = roomKeyOf(stream);

  const by = sender.handle;
  const fromBot = msg.isBot || msg.tags.includes("chat:from-bot");
  const by_kind = fromBot ? (sender.known && isBeing(by) ? "resident" : "walker") : "human";

  const handleOf = (id) => identityFor({ platform: server.platform, id, display: null }).handle;
  // id-shaped mentions first (adapter.rewriteMentions); then a literal
  // `@<displayName>` naming THIS server's own bot — the shape a platform's
  // own cleanContent rendering leaves behind when no `<@id>` token survived
  // (docs/research/mcpl.md §3.4; the 2026-09-10 "@vallynn" observation).
  // mentionsIn(text, beings) below already re-scans the result, so the
  // being's handle lands in `mentions` too once this rewrite has run.
  const text = rewriteSelfMention(
    adapter.rewriteMentions(adapter.text(msg), handleOf),
    server.displayName ?? null,
    server.being,
  );
  const mentions = [
    ...new Set([...adapter.mentions(msg).map(handleOf), ...mentionsIn(text, beings)]),
  ];
  const replied = adapter.reply(msg);
  const reply_to = replied?.authorId ? handleOf(replied.authorId) : null;
  // the servers file's own title is an explicit override (set wins); absent
  // that, the platform's own naming facts for THIS message — a DM's other
  // party is always `by` (chat:from-self already filtered, so any sender
  // reaching here is the DM's one other participant).
  const descriptor = adapter.roomDescriptor(msg, { dmHandle: messageKind === "dm" ? by : null });
  const roomTitle = configured?.title ?? adapter.titleFor(descriptor) ?? null;

  /** @type {RouteAction[]} */
  const actions = [];
  if (!open) {
    actions.push({
      kind: "open-room",
      platform: server.platform,
      stream,
      title: roomTitle,
      beings,
    });
  }
  for (const { bytes, mime, filename } of adapter.blobs(msg))
    actions.push({ kind: "share-blob", stream, by, bytes, mime, filename, roomTitle });

  const message = { by, text, mentions, reply_to, kind: messageKind, by_kind };
  const room = {
    beings,
    humans_present: 0,
    bot_mention_streak: streakOf(stream),
    ...(rng ? { rng } : {}),
  };
  // a group/channel room is auth-gated by default: an unlinked human
  // (never the keeper, never a bot) neither activates nor rolls the
  // random-wake dice there — `public: true` on the room is the only lift.
  const gated =
    messageKind !== "dm" &&
    by_kind === "human" &&
    configured?.public !== true &&
    sender.linked !== true &&
    !isKeeper(by);

  const activated = [];
  const reasons = {};
  let notice = false;
  if (gated) {
    for (const being of beings) reasons[being] = "unlinked-room";
    notice = beings.some((b) => mentions.includes(b) || reply_to === b);
  } else {
    for (const being of beings) {
      const covenant = covenants(being, roomKey);
      const d = decideActivation({
        being: { handle: being, awake: awakeOf(being) },
        covenant,
        message,
        room,
      });
      reasons[being] = d.reason;
      if (d.activate) activated.push(being);
      else if (d.reason === "asleep" && d.targets.includes(being))
        actions.push({ kind: "receipt", stream, being, by, roomTitle });
    }
  }

  // the record is the single copy of the room — every message that reaches
  // a configured/open room enters it, as `input`; the house's own
  // decideActivation, above, is what decides who (if anyone) actually
  // turns: `targets` when someone activates, `observe: true` when nobody
  // does (recorded, no walker dispatched — "record but don't wake").
  actions.push({
    kind: "input",
    stream,
    by,
    by_kind,
    home: server.platform,
    text,
    targets: activated,
    ...(activated.length === 0 ? { observe: true } : {}),
    ...(notice ? { notice: true } : {}),
    reasons,
    messageKind,
    roomTitle,
    external: {
      platform: server.platform,
      message_id: msg.messageId,
      author: by,
      reply_to: replied?.messageId ?? null,
    },
  });
  return actions;
}

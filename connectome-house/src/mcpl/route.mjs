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
import { handleCommand } from "../commands/index.mjs";
import { decideActivation, mentionsIn, pickRandomReplyLotteryWinner } from "../dispatch.mjs";
import { canonicalStream } from "../stream-key.mjs";
import { adapterFor, rewriteSelfMention } from "./adapters.mjs";
import {
  DISPATCH_DEFAULTS as DISCORD_DISPATCH_DEFAULTS,
  editOrDeleteNotice,
  isReactionEvent,
  isRedactReaction,
  reactionInfo,
} from "./discord.mjs";
import { DISPATCH_DEFAULTS as SIGNAL_DISPATCH_DEFAULTS } from "./signal.mjs";

/** harness-port P-F, 2026-09-17 (mission task 1; PARITY-discord.md §5,
 * mcpl-signal/PARITY.md §5): the edit/delete signal a platform actually
 * gives is NOT uniform. mcpl-signal's own envelopes are properly
 * structured (`chat:edited`/`chat:deleted` tags, a real `targetMessageId`
 * field carried in `metadata` — mcpl-signal/PARITY.md §5's own citation of
 * envelopes.mjs's `toEditPush`/`toDeletePush`) — read directly off
 * `msg.tags`/`msg.metadata` here rather than through a signal.mjs export
 * (signal.mjs is NO-TOUCH for this task, and this is a plain SPEC-level
 * tag/field convention, not Signal-specific logic). discord-mcpl's own
 * push carries no `messageId` in `origin` at all (a real upstream gap,
 * discord.mjs's own header) — its ONLY signal is an exact TEXT template,
 * parsed by discord.mjs's `editOrDeleteNotice`; an edit's own target id is
 * recoverable only from `msg.eventId`'s `discord_edit_<messageId>` shape
 * (named there, read here). A platform giving neither shape is simply not
 * an edit/delete here — honest absence, never guessed.
 * @param {IncomingMessage} msg @param {string} platform
 * @returns {{kind: "edit", messageId: string|null, text: string}
 *   | {kind: "delete", messageId: string|null} | null} */
function editOrDeleteInfo(msg, platform) {
  if (msg.tags.includes("chat:edited")) {
    const id = msg.metadata?.targetMessageId;
    return { kind: "edit", messageId: id != null ? String(id) : null, text: msg.text };
  }
  if (msg.tags.includes("chat:deleted")) {
    const id = msg.metadata?.targetMessageId;
    return { kind: "delete", messageId: id != null ? String(id) : null };
  }
  if (platform === "discord") {
    const notice = editOrDeleteNotice(msg);
    if (!notice) return null;
    if (notice.kind === "delete") return { kind: "delete", messageId: notice.messageId };
    const m = /^discord_edit_(.+)$/.exec(msg.eventId ?? "");
    return { kind: "edit", messageId: m ? m[1] : null, text: notice.text };
  }
  return null;
}

/** the random-reply flavour each platform defaults to (00-stack-as-is.md
 * §4.2, 02-user-contract.md O6): DATA, owned by each platform module
 * (discord.mjs/signal.mjs's own `DISPATCH_DEFAULTS`), never a hardcoded
 * per-platform branch in the dispatch logic itself (dispatch.mjs stays
 * platform-agnostic; only THIS lookup knows platform names at all). A
 * being's own covenant.dispatch always wins when it sets either field
 * explicitly — this is a DEFAULT, applied only where the covenant is
 * silent (see mergedCovenant below). An unregistered/mock platform gets
 * an empty default (independent-roll, unsuppressed) — today's existing
 * behaviour, unchanged. */
const PLATFORM_DISPATCH_DEFAULTS = {
  discord: DISCORD_DISPATCH_DEFAULTS,
  signal: SIGNAL_DISPATCH_DEFAULTS,
};

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/**
 * @typedef {Object} RouteServer
 * @property {string} name
 * @property {string} platform
 * @property {string} being the handle this server's one bot identity speaks for
 * @property {string|null} [displayName] the platform's own rendered name for
 *   `being` (self-display.mjs's learned answer, or null when not yet known)
 * @property {string|null} [being_id] the platform's own id for this account
 *   (config.mjs's own field) — stream-key.mjs's `canonicalStream` account
 *   segment, when this platform has no dedicated id field of its own
 * @property {string|null} [number_id] an alternate account-id field name
 *   (e.g. a Signal number), read when `being_id` is unset
 * @property {boolean} [primary] whether THIS server is its platform's
 *   first-seated account (config.mjs/seat.mjs's own concern — unset here
 *   defaults true, matching stream-key.mjs's own default: a caller that
 *   never sets this sees no behaviour change at all, single-account or not)
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
 * @property {(roomId: string, messageId: string) => number|null} [frameSeqFor]
 *   harness-port P-F, 2026-09-17 (mission task 1): a platform message id,
 *   in an ALREADY-OPEN room, resolved to that room's own frame `seq`
 *   (mcpl/message-index.mjs, built from external.jsonl) — the single
 *   lookup RX1/RX2 (🫥 redaction) and O21/O22 (edit/delete) all need.
 *   default: () => null (an unresolvable target is an honest `ignore`,
 *   never guessed).
 */
/** @typedef {{kind: "ignore", reason: string}
 *   | {kind: "open-room", platform: string, stream: string, title: string|null, beings: string[]}
 *   | {kind: "share-blob", stream: string, by: string, bytes: Buffer, mime: string,
 *       filename: string|null, roomTitle: string|null}
 *   | {kind: "receipt", stream: string, being: string, by: string, roomTitle: string|null}
 *   | {kind: "redact", stream: string, roomId: string, target: number,
 *       action: "add"|"remove", by: string}
 *   | {kind: "edited", stream: string, roomId: string, target: number, text: string,
 *       edited_at?: string}
 *   | {kind: "retracted", stream: string, roomId: string, target: number}
 *   | {kind: "command", stream: string, by: string, roomTitle: string|null,
 *       reply: string|null, intent: Record<string, any>|null, being: string|null}
 *   | {kind: "input", stream: string, by: string, by_kind: "human"|"resident"|"walker",
 *       home: string, text: string, targets: string[], observe?: true, notice?: true,
 *       reasons: Record<string, string>, messageKind: "dm"|"group"|"channel",
 *       roomTitle: string|null,
 *       external: {platform: string, message_id: string|null,
 *       author: string, reply_to: string|null}}} RouteAction
 * `command` (harness-port R2-W, 2026-09-17, mission task 1): a recognized
 * `!`-command (or the bare `continue`/`h-once` shapes commands/grammar.mjs
 * also parses) — the ONLY action this call returns (it short-circuits
 * before room admission/dispatch entirely, matching 03-house-design.md
 * §5: never a room turn, never an activation). `reply` (nullable) is
 * chat-visible text to send back as the house, never as `being`'s own
 * speech; `intent` (nullable) is the typed effect a caller applies via
 * room-turn.mjs's `applyInterrupt`/`applySteer` (kind `interrupt`/
 * `steer`) or commands/store.mjs's settings tiers (kind `setting`) —
 * commands/index.mjs's own file header lists every intent kind a command
 * can produce. See this task's own report for what still isn't wired to
 * a live seat.
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
  frameSeqFor = () => null,
}) {
  if (msg.envelope === "history") return [{ kind: "ignore", reason: "history-kept" }];
  if (msg.tags.includes("chat:from-self")) return [{ kind: "ignore", reason: "from-self" }];
  const stream = adapter.roomKey(msg);
  if (!stream) return [{ kind: "ignore", reason: "no-channel" }];

  // harness-port R2-W, 2026-09-17: LOOKUP ONLY — canonicalStream (stream-
  // key.mjs) disambiguates a Signal DM by its RECEIVING account once this
  // server isn't the platform's primary/first-seated one (a peer DMing two
  // house numbers must land in two rooms, never share one — a privacy bug,
  // not just a mismatch). A fresh mint still stores the RAW `stream`
  // (every action below keeps using the `stream` local, not this lookup
  // key) — this key is never written to disk by this module, only used to
  // ask "is a room already open/configured under the key THIS account
  // would use".
  //
  // canonicalStream's own peer digest means its output is NEVER identical
  // to a bare raw stream, even for the default/primary case (stream-
  // key.mjs's own module header: "neither segment this module hands back
  // is ever a raw... uuid verbatim") — so a keeper's servers.json (raw,
  // human-legible stream ids) and every room this house minted before
  // this task would never match the canonical key by exact equality. The
  // PRIMARY account (the common case — every non-Signal platform, and
  // every single-Signal-number deployment) therefore falls back to the
  // raw `stream` when the canonical key finds nothing — "a caller
  // matching against disk falls back to the raw form", stream-key.mjs's
  // own words, done here rather than in the (NO-TOUCH) seat.mjs.
  //
  // The two lookups fall back differently, on purpose:
  // - `configured` (the KEEPER's own static allowlist, servers.json) is
  //   always raw-authored — a keeper writes the same platform-level DM
  //   stream id for a peer into EVERY account's own `rooms` list, with no
  //   notion of a digested/account-keyed form at all. Matching it never
  //   reuses a specific room object, only confirms "this stream is
  //   allowed" — so it falls back to the raw form for EVERY account,
  //   primary or not.
  // - `open` (the LIVE room registry) is where reuse actually happens: a
  //   non-primary account falling back to the same bare raw key a primary
  //   account already opened under would hand it THAT room — exactly the
  //   collision this task exists to remove. Only a primary account takes
  //   this fallback.
  const primaryFlag = server.primary ?? true;
  const account = server.being_id ?? server.number_id ?? null;
  const isPrimaryAccount = typeof primaryFlag === "function" ? primaryFlag(account) : primaryFlag;
  const lookupStream = canonicalStream(server.platform, stream, { account, primary: isPrimaryAccount });
  const configured =
    server.rooms.find((r) => r.stream === lookupStream) ??
    server.rooms.find((r) => r.stream === stream) ??
    null;
  const open = roomsOpen(lookupStream) ?? (isPrimaryAccount ? roomsOpen(stream) : null);

  // harness-port P-F, 2026-09-17 (mission task 1): reactions, edits, and
  // deletes are META-events on an ALREADY-recorded message, never room
  // admission or a turn of their own — handled here, BEFORE the ordinary
  // `msg.author.id` requirement below (discord-mcpl's own reaction/edit/
  // delete pushes carry no `authorId` in `origin` at all — confirmed
  // against its own fixtures, test/mcpl-discord.test.mjs — so gating on
  // author presence first would silently swallow every one of these as
  // "no-author") and before the command lane (an edited message's own new
  // text could otherwise start with "!" and be misread as a fresh
  // command). isReactionEvent/reactionInfo/isRedactReaction are SPEC-level
  // tag conventions (`chat:reaction`/`chat:reaction-remove`), confirmed
  // platform-agnostic against mcpl-signal/PARITY.md §2's own
  // `toReactionPush` (same tag pair) — reused verbatim for every platform,
  // not just Discord's.
  if (isReactionEvent(msg)) {
    if (!open) return [{ kind: "ignore", reason: "reaction-no-room" }];
    const info = reactionInfo(msg);
    if (!info || !info.messageId || !info.reactorId)
      return [{ kind: "ignore", reason: "reaction-no-target" }];
    if (!isRedactReaction(info.emoji)) return [{ kind: "ignore", reason: "reaction-not-redaction" }];
    const target = frameSeqFor(open.id, info.messageId);
    if (target == null) return [{ kind: "ignore", reason: "reaction-target-not-found" }];
    const hider = identityFor({
      platform: server.platform,
      id: info.reactorId,
      display: info.reactorName,
    }).handle;
    return [{ kind: "redact", stream, roomId: open.id, target, action: info.action, by: hider }];
  }
  const editOrDelete = editOrDeleteInfo(msg, server.platform);
  if (editOrDelete) {
    if (!open) return [{ kind: "ignore", reason: `${editOrDelete.kind}-no-room` }];
    if (!editOrDelete.messageId) return [{ kind: "ignore", reason: `${editOrDelete.kind}-no-target-id` }];
    const target = frameSeqFor(open.id, editOrDelete.messageId);
    if (target == null) return [{ kind: "ignore", reason: `${editOrDelete.kind}-target-not-found` }];
    if (editOrDelete.kind === "edit")
      return [
        {
          kind: "edited",
          stream,
          roomId: open.id,
          target,
          text: editOrDelete.text,
          ...(typeof msg.timestamp === "string" ? { edited_at: msg.timestamp } : {}),
        },
      ];
    return [{ kind: "retracted", stream, roomId: open.id, target }];
  }

  if (!msg.author.id) return [{ kind: "ignore", reason: "no-author" }];
  const sender = identityFor(adapter.sender(msg));
  const messageKind = adapter.roomKind(msg);
  const by = sender.handle;
  const roomKey = roomKeyOf(stream);

  // harness-port R2-W, 2026-09-17 (mission task 1): the command lane runs
  // BEFORE room admission, on every platform (03-house-design.md §5) — a
  // recognized command never reaches the record as a room turn and never
  // activates a being. `ctx.being` names THIS server's own bound identity
  // (`server.being`, the one account whose send tool would speak the
  // reply) — a room seating several beings still attributes a command's
  // effect to this seat's own being, absent a finer per-being address
  // this round doesn't add. KNOWN GAP (this task's own report): nothing
  // downstream of this return value yet actually SENDS `reply` through a
  // seat's speak path or applies `intent` to a live turn — that wiring
  // is mcpl/seat.mjs's own job (NO-TOUCH for this task); room-turn.mjs's
  // `applyInterrupt`/`applySteer` (this round's own intent hooks) and
  // commands/store.mjs's `applyCommandDispatchSettings` (this round's own
  // rr/bb consumer) are built and tested directly, ready for that seam.
  const commandResult = handleCommand(msg, {
    platform: /** @type {"discord"|"signal"|"web"} */ (server.platform),
    roomKey,
    by,
    being: server.being ?? null,
    isKeeper,
  });
  if (commandResult) {
    return [
      {
        kind: "command",
        stream,
        by,
        roomTitle: configured?.title ?? null,
        reply: commandResult.reply,
        intent: commandResult.intent,
        being: server.being ?? null,
      },
    ];
  }

  if (!configured && !open && !admitsUnlistedDM({ messageKind, sender, isKeeper }))
    return [{ kind: "ignore", reason: "unconfigured" }];
  const beings = open?.beings?.length
    ? open.beings
    : configured?.beings?.length
      ? configured.beings
      : [server.being];

  // harness-port R2-W, 2026-09-17 (dispatch-signal-matrix TODO 1): a
  // platform's own bot flag/tag is Discord's own signal — Signal has none
  // (mcpl-signal's facts() hardcodes isBot:false, confirmed by its own
  // README's "no notion of another bot at all"). Falling back to the
  // house's OWN identity map — a sender that resolves to a KNOWN BEING
  // handle counts as a bot too — closes that gap for every platform at
  // once, exactly as mcpl-signal's README already asks a host to do ("a
  // host decides bot-ness by its own identity map").
  const fromBot =
    msg.isBot || msg.tags.includes("chat:from-bot") || (sender.known && isBeing(sender.handle));
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
  // computed ONCE per message, before the per-being loop (02-user-
  // contract.md O6's own proposed fix, verbatim): whether ANY being
  // present was mentioned/replied-to by this message — independent of
  // which being is asking. dispatch.mjs's random branch reads this off
  // `room.any_being_targeted` to decide whether a covenant that opts in
  // to suppression (`random_reply_suppressed_by_other_target`) should
  // skip its own roll entirely this message.
  const anyTargeted = beings.some((b) => mentions.includes(b) || reply_to === b);
  const room = {
    beings,
    humans_present: 0,
    bot_mention_streak: streakOf(stream),
    any_being_targeted: anyTargeted,
    ...(rng ? { rng } : {}),
  };
  /** a being's own covenant, with THIS platform's random-reply defaults
   * (above) filled in only where the covenant itself is silent — an
   * explicit field on the covenant always wins.
   * @param {string} being */
  const covenantWithDispatchDefaults = (being) => {
    const base = covenants(being, roomKey);
    const defaults = PLATFORM_DISPATCH_DEFAULTS[server.platform] ?? {};
    return { ...base, dispatch: { ...defaults, ...(base?.dispatch ?? {}) } };
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
  // harness-port P-F, 2026-09-17 (mission task 2; 08-pilot-observe.md §2):
  // an observe_only seat records everything but never activates a being —
  // decideActivation is never even called (no lottery draw, no random-wake
  // roll), which is what keeps turns.begin/typing and any being-tool call
  // (reactions) from ever firing at all — belt. speak.mjs's own gate is the
  // suspenders (the `!`-command reply lane bypasses this one).
  // observe_only silences THIS seat's own being only: every other being
  // present keeps its normal decision, so whichever seat records the message
  // first still starts the right turn on the room's shared seat (the race a
  // second bot identity in the same channel always runs).
  const others = server.observe_only ? beings.filter((b) => b !== server.being) : beings;
  if (server.observe_only) reasons[server.being] = "observe_only";
  if (server.observe_only && others.length === 0) {
    // nothing else to decide
  } else if (gated) {
    for (const being of others) reasons[being] = "unlinked-room";
    notice = others.some((b) => mentions.includes(b) || reply_to === b);
  } else {
    // Discord's one-winner lottery (O6): computed AT MOST ONCE per
    // message, off a SINGLE seeded draw — never one draw per being (that
    // would let a shared-rng roll hand every present being its own
    // independent win). Only attempted when nobody was targeted at all
    // (an addressed message never reaches the random branch for anyone —
    // the suppression rule below handles that case on its own) and the
    // first being's own (defaulted) covenant actually asks for it; every
    // being in one room shares one platform, so this is effectively a
    // room-wide setting read once, not a per-being fork.
    let lotteryDecided = false;
    let lotteryWinner = null;
    for (const being of others) {
      const covenant = covenantWithDispatchDefaults(being);
      if (!anyTargeted && !lotteryDecided && covenant?.dispatch?.random_reply_single_winner === true) {
        lotteryWinner = pickRandomReplyLotteryWinner({
          beings: others.map((h) => ({ handle: h, awake: awakeOf(h) })),
          covenantsFor: covenantWithDispatchDefaults,
          message,
          room,
        });
        lotteryDecided = true;
      }
      const d = decideActivation({
        being: { handle: being, awake: awakeOf(being) },
        covenant,
        message,
        room: lotteryDecided ? { ...room, lottery_winner: lotteryWinner } : room,
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

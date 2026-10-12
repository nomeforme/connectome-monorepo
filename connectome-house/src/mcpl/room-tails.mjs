// @ts-check
// harness/src/mcpl/room-tails.mjs — a seat's own room tracking: mint,
// reuse, or reopen a room live, retried past a transient lock (409); and
// (harness-port R2-X, 2026-09-17, mission task 1) applying a routed
// `{kind:"command"}` action against that same live room.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendHouseFrame, lastFrameInfo } from "../frames-io.mjs";
import { open } from "../open-rooms.mjs";
import { activeFork, forkRoom, leaveFork } from "../room-fork.mjs";
import { applyContinue, applyInterrupt, applySteer, commandRoomKeyFor } from "../room-turn.mjs";
import { primaryBeingOf } from "../room-seats.mjs";
import { readCls } from "../room-policy.mjs";
import { resetAutotriggerPacing } from "../autotrigger.mjs";
import { canonicalStream } from "../stream-key.mjs";
import { currentHiddenBy } from "./message-index.mjs";
import { registerSeatTracking, trackRoomOnAllSeats } from "./seat-registry.mjs";

const RETRY_MS = 1500;

// a stream lock outlasting ensureLive's own retry budget — the platform
// already got accepted:true, so the caller parks rather than drops it.
export class StillLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "StillLockedError";
    this.code = 409;
  }
}

/** route.mjs's own primary/account computation (mission task 2), kept
 * here rather than imported from route.mjs (NO-TOUCH) — a short, pure
 * rule stream-key.mjs's own header already documents; duplicated
 * deliberately rather than reached for across that boundary.
 * @param {{primary?: boolean|((account: string) => boolean), being_id?: string|null,
 *   number_id?: string|null}} cfg */
function accountKeyOf(cfg) {
  const account = cfg.being_id ?? cfg.number_id ?? null;
  const flag = cfg.primary ?? true;
  const isPrimary = typeof flag === "function" ? flag(account) : flag;
  return { account, isPrimary };
}

/** @param {{cfg: {platform: string, being: string, mock?: boolean, primary?: boolean,
 *   being_id?: string|null, number_id?: string|null}, RUNS: string,
 *   openRoom: (opts: object) => Promise<any>,
 *   roomsOpen: (stream: string) => {id: string, beings: string[], live: boolean}|null}} deps */
export function createRoomTails({ cfg, RUNS, openRoom, roomsOpen }) {
  /** @type {Map<string, {stream: string, runDir: string, offset: number, forkName?: string|null, attachedAt: number}>} */
  const tails = new Map();

  /** tail from the cursor: the record's own current byte END, at the exact
   * moment this seat attaches — NEVER `cursor.mjs`'s own `tailOffsetFor`
   * (NO-TOUCH), which resumes from THIS BEING's last-handled `seq`.
   *
   * Hardened after the 2026-09-20 incident (docs/harness-port/
   * 24-incident-2026-09-20-cascade.md, guardrail #3): `tailOffsetFor` is
   * seq-ordered, not time-ordered — for room `3c51ff61…` a genuine prior
   * send had reached seq≈12.5, and a *later* retrofit then appended 514
   * frames at seq 13.5–527.5 carrying their own OLD `t` (months old). Any
   * seat resuming "from my own last-handled seq" saw the entire
   * retrofitted backlog as unhandled, however old it actually was — a
   * correct-by-design resume mechanism made unsafe by a same-file writer
   * (an import/retrofit) inserting old content at new, higher seqs. A
   * seat's FIRST attach to a room therefore always starts at the file's
   * CURRENT size, full stop, never at any prior "where did I leave off"
   * bookkeeping — rule 2's own age fence (mcpl/outbound-guard.mjs,
   * consulted by speak.mjs/relay.mjs) is the layer that still lets a
   * being answer for a short, genuine gap (redeliver.mjs's own SEPARATE
   * not-ready retry mechanism, keyed off external.jsonl, is unaffected by
   * this offset at all). `attachedAt` is stamped at this same instant —
   * THIS is "when this seat attached to this room" for that fence: a
   * frame timestamped before it, however it got appended (a concurrent
   * restore/retrofit writer, a slow duplicate, anything), is never
   * eligible outward.
   * `forkName` (mission task 3, C13): set when `id` is a `!stream in`
   * child, never the platform's own room — the ONLY thing that tells
   * seat.mjs's onFrame to prepend the fork's own relay prefix before a
   * fork's speech goes out to `stream` (the PARENT's real channel; a
   * fork has none of its own).
   * @param {string} id @param {string} stream @param {{forkName?: string|null}} [opts] */
  function trackRoom(id, stream, { forkName = null } = {}) {
    if (tails.has(id)) return;
    const runDir = join(RUNS, id);
    const framesPath = join(runDir, "frames.jsonl");
    const offset = existsSync(framesPath) ? statSync(framesPath).size : 0;
    tails.set(id, { stream, runDir, offset, forkName, attachedAt: Date.now() });
  }
  // the two-beings-on-Signal incident (2026-09-19 21:49, bug A): offered
  // to every OTHER seat's own ensureLive below, so a slow second delivery
  // never delays this room's tracking on ITS side.
  registerSeatTracking(cfg.platform, cfg.being, cfg.rooms_policy, trackRoom);

  /** the room for `stream`, live — minted, returned as-is, or reopened.
   * Looked up (and, for a non-primary Signal account, MINTED) by the same
   * canonical key route.mjs's own routeIncoming decides with — so two
   * Signal servers DMed by the same peer land in two rooms, never one
   * (mission task 2). The PRIMARY account (or any non-Signal-DM stream,
   * where canonicalStream is the identity) keeps minting under the exact
   * raw `stream`, unchanged — openRoomLocked's own comment: "a fresh mint
   * keeps the raw stream... never a rewrite at birth"; a non-primary
   * account mints under the canonical, account-scoped key instead — the
   * only seam available from an owned file that stops openRoom's own
   * (NO-TOUCH) findRoom from reusing the primary account's room for the
   * very same peer. `trackRoom` below always keys off the TRUE raw
   * `stream` regardless, so outbound delivery (speak.mjs's `channelId`)
   * is never affected by which key a room minted under.
   * @param {string} stream @param {{title?: string|null, beings?: string[]|null}} [opts]
   * @param {number} [tries] @returns {Promise<string>} */
  async function ensureLive(stream, { title = null, beings = null } = {}, tries = 4) {
    const { account, isPrimary } = accountKeyOf(cfg);
    const lookupStream = canonicalStream(cfg.platform, stream, { account, primary: isPrimary });
    const known = roomsOpen(lookupStream) ?? (isPrimary ? roomsOpen(stream) : null);
    // the servers file's own roster for this stream outranks a record that predates it
    const configured = (cfg.rooms ?? []).find((r) => r.stream === stream)?.beings ?? null;
    let roster = beings?.length ? beings : configured?.length ? configured : known?.beings?.length ? known.beings : [cfg.being];
    // bug B (rooms_policy: "any"): an EXISTING room's own known roster
    // never carried this seat's own being in — under "any" it always joins.
    if (cfg.rooms_policy === "any" && !roster.includes(cfg.being)) roster = [...roster, cfg.being];
    const mintStream = isPrimary ? stream : lookupStream;
    const r = await openRoom({
      platform: cfg.platform,
      stream: mintStream,
      title,
      beings: roster,
      who: { handle: roster[0], home: cfg.platform },
      mock: cfg.mock,
    });
    if (r.error && r.code === 409 && tries > 1) {
      await new Promise((res) => setTimeout(res, RETRY_MS));
      return ensureLive(stream, { title, beings }, tries - 1);
    }
    if (r.error && r.code === 409) throw new StillLockedError(`openRoom ${stream}: ${r.error}`);
    if (r.error) throw new Error(`openRoom ${stream}: ${r.error}`);
    trackRoom(r.id, stream);
    // house-side, at once — never wait for a sibling seat's own copy.
    trackRoomOnAllSeats(r.id, stream, cfg.platform, cfg.being);
    return r.id;
  }

  return { tails, trackRoom, ensureLive };
}

/** a routed `{kind:"command"}` action (route.mjs, mission task 1) against
 * a live seat: ensures the room, records the raw command line observe-
 * only (no activation — `targets: []` bypasses roomInput's own activation
 * decision entirely), applies an `interrupt`/`steer` intent to the room's
 * open turn via room-turn.mjs's own hooks, then sends the command's
 * `reply` back through the seat's speak path AS THE HOUSE, quoting the
 * command message (`replyTo`). A `setting` intent needs nothing further
 * here — commands/store.mjs already persisted it before route.mjs ever
 * returned the action; `swallow`/`continue`/`input-trim`/`secret-*` have
 * no live seat-side consumer yet (a named gap, not a silent skip — see
 * this task's own report). `stream` (C13, this task's own mission)
 * forks/unforks the room via room-fork.mjs and starts/stops tailing the
 * child so its speech relays back through this same seat.
 * @param {{cfg: {platform: string}, ensureLive: (stream: string, opts: object) => Promise<string>,
 *   roomInput: (args: object) => Promise<any>, speak: (roomId: string, stream: string,
 *   text: string, opts: object) => Promise<void>, say: (line: string) => void,
 *   trackRoom: (id: string, stream: string, opts?: object) => void,
 *   tails: Map<string, {stream: string, runDir: string, offset: number, forkName?: string|null}>,
 *   drainOne?: (roomId: string) => void}} deps
 * @param {{stream: string, by: string, roomTitle: string|null, reply: string|null,
 *   intent: Record<string, any>|null}} action
 * @param {{messageId?: string|null, text: string}} msgCtx
 * @returns {Promise<string>} the room id the command was applied against */
export async function applyCommandAction({ cfg, ensureLive, roomInput, speak, say, trackRoom, tails, drainOne }, action, msgCtx) {
  const roomId = await ensureLive(action.stream, { title: action.roomTitle ?? null });
  const r = await roomInput({
    id: roomId,
    by: action.by,
    home: cfg.platform,
    text: msgCtx.text,
    targets: [],
    observe: true,
    external: { platform: cfg.platform, message_id: msgCtx.messageId ?? undefined },
  });
  if (r.error) say(`command from @${action.by} in ${action.stream} could not be recorded: ${r.error}`);
  if (action.intent) {
    const rec = open.get(roomId);
    if (rec) {
      if (action.intent.kind === "interrupt") applyInterrupt(rec, action.intent.being);
      else if (action.intent.kind === "continue") applyContinue(rec, action.intent.being ?? primaryBeingOf(rec.cls));
      else if (action.intent.kind === "steer")
        applySteer(rec, { by: action.by, text: action.intent.message, being: action.intent.being });
      else if (action.intent.kind === "stream") {
        if (action.intent.direction === "in") {
          const at_seq = Math.floor(lastFrameInfo(join(rec.runDir, "frames.jsonl")).seq);
          const child = await forkRoom(roomId, { name: action.intent.name, at_seq, by: action.by });
          const childRec = open.get(child.id);
          // harness-port W7: every being's own seat the parent currently
          // holds rides along to the child, not just one — a fork inherits
          // the WHOLE room's seat state at the moment it's minted.
          if (childRec) for (const [being, seat] of rec.seats ?? []) childRec.seats.set(being, seat);
          trackRoom(child.id, action.stream, { forkName: child.name });
        } else {
          const prev = activeFork(roomId);
          // one last drain before the sweep loses its only chance (the
          // child's own speech may not be swept yet — harness-port W7-b).
          if (prev) {
            drainOne?.(prev.id);
            tails.delete(prev.id);
          }
          leaveFork(roomId);
        }
      }
    }
  }
  if (action.reply)
    void speak(roomId, action.stream, action.reply, { by: "house", replyTo: msgCtx.messageId ?? null });
  return roomId;
}

/** a routed `{kind:"input"}` action (route.mjs) against a live seat — the
 * ordinary (non-command) half of `apply()`'s own loop, extracted
 * (mission task 3, C13) both to keep seat.mjs under its own line-length
 * ratchet and to give the fork redirect ONE call site: when `roomId`'s
 * room currently has an active fork (room-fork.mjs's `activeFork`), the
 * turn writes to the CHILD record instead — the being's own history for
 * this stream, from here on, lives there until `!stream out`. Every
 * downstream bookkeeping key (the relay's platform-origin mark, the
 * pending-reply queue) is redirected the same way, so onFrame's later
 * poll of the child room's own tail resolves them consistently.
 * @param {{cfg: {platform: string, being: string}, roomInput: (args: object) => Promise<any>,
 *   relay: {markPlatformOrigin: (roomId: string, by: string, text: string) => void},
 *   turns: {activate: (stream: string, being: string) => void,
 *     end: (stream: string, being: string, reason: string) => void,
 *     stopTyping: (stream: string, reason: string) => void},
 *   pendingReply: {push: (roomId: string, being: string, messageId: string) => void, drop?: (roomId: string, being: string) => void},
 *   stats: {inputs: number}, streaks: Map<string, number>,
 *   linkGate: {notifyUnlinkedRoom: (msg: object, stream: string) => void},
 *   addParticipant: (runDir: string, id: string, handle: string, home: string, via: string, kind: string) => void}} deps
 * @param {import("./route.mjs").RouteAction} action a `{kind:"input"}` action
 * @param {{msg: {messageId?: string|null}, runDir: string, attachments: {path: string}[]}} ctx */
export async function applyInputAction(
  { cfg, roomInput, relay, turns, pendingReply, stats, streaks, linkGate, addParticipant },
  action,
  { msg, runDir, attachments, roomId },
) {
  const a = action;
  if (a.notice) linkGate.notifyUnlinkedRoom(msg, a.stream);
  if (a.by_kind !== "human") addParticipant(runDir, roomId, a.by, a.home, "room", a.by_kind);
  // any human input resets this room's own autotrigger pacing (K3,
  // harness-port W6-R3) — an argued addition, no fleet citation names
  // this exact trigger; autotrigger.mjs's own header says so. An
  // unreadable class.json (a room mid-open, or a test's synthetic rec)
  // is an honest no-op, never a throw that would break routing itself.
  else {
    try {
      resetAutotriggerPacing(commandRoomKeyFor(readCls(runDir)));
    } catch {}
  }
  const fork = activeFork(roomId);
  const targetId = fork?.id ?? roomId;
  const r = await roomInput({
    id: targetId,
    by: a.by,
    home: a.home,
    text: a.text,
    targets: a.targets,
    observe: a.observe,
    ...(attachments.length ? { attachments: attachments.map((s) => s.path) } : {}),
    external: {
      platform: a.external.platform,
      message_id: a.external.message_id ?? undefined,
      reply_to: a.external.reply_to ?? undefined,
    },
  });
  if (r.error) throw new Error(`roomInput: ${r.error}`);
  // harness-port 34 (typing-after-decision, docs/harness-port/
  // 34-typing-after-decision.md): typing/lifecycle for THIS seat's own
  // being now switch on HERE, and only here — never speculatively in
  // seat.mjs's own onIncoming, before this room's own decision is known.
  // A win records exactly `a.targets` (`roomInput` never re-decides once
  // `targets` rides the call); a `{duplicate:true}` answer's own recorded
  // targets are the FIRST caller's, read back off the frame it wrote
  // (serve-rooms.mjs's own `to`) — never this seat's own (possibly
  // different) `random_reply` roll. Gated on `unseated` below too: never
  // start typing for a being this exact call already knows has no seat to
  // answer on at all.
  const recordedTargets = r.duplicate ? (r.to ?? []) : a.targets;
  const unseated = r.unseated ?? [];
  if (recordedTargets.includes(cfg.being) && !unseated.includes(cfg.being)) turns.activate(a.stream, cfg.being);
  // harness-port W7, 2026-09-19: a target `roomInput` reports `unseated`
  // got no turn at all (no seat to begin one on) — the message still
  // entered the record; what's left is releasing whichever seat started
  // typing for it. Only THIS seat's own being's typing is ever this
  // seat's to release (mcpl/turns.mjs's own `own`-scoped typing loop).
  if (unseated.length) {
    for (const being of unseated) turns.end(a.stream, being, "no seat");
    if (unseated.includes(cfg.being)) turns.stopTyping(a.stream, "no seat for the being");
  }
  // already recorded — another bot's child saw it first, or it's an
  // echo of this being's own speech (chat:from-bot): held once.
  if (r.duplicate) {
    // this seat's own being is among the ROOM's own recorded targets —
    // some seat's own turn is (or should be) running for it; typing was
    // just activated above if this seat is the one that owns its voice.
    if (recordedTargets.includes(cfg.being)) {
      // and its answer still replies to THIS message, the way a lone seat's would
      if (msg.messageId && a.reasons?.[cfg.being] === "reply") pendingReply.push(targetId, cfg.being, msg.messageId);
      else pendingReply.drop?.(targetId, cfg.being);
      return;
    }
    // never a recorded target — nothing of this seat's own was ever
    // activated above; stopTyping is idempotent, a harmless no-op here.
    turns.stopTyping(a.stream, "duplicate");
    return;
  }
  stats.inputs += 1;
  relay.markPlatformOrigin(targetId, a.by, a.text);
  streaks.set(
    a.stream,
    a.by_kind === "human" ? 0 : (streaks.get(a.stream) ?? 0) + (a.targets.length ? 1 : 0),
  );
  // the keeper's UX (2026-09-19): only an answer to a REPLY threads back; a mention
  // or a DM is answered plain, as the fleet always did
  for (const being of a.targets) {
    if (msg.messageId && a.reasons?.[being] === "reply") pendingReply.push(targetId, being, msg.messageId);
    else pendingReply.drop?.(targetId, being);
  }
}

/** harness-port P-F, 2026-09-17 (mission task 1): a routed `{kind:"redact"|
 * "edited"|"retracted"}` action (route.mjs) applied against an ALREADY-open
 * room — never `ensureLive` (route.mjs only emits these once `open` was
 * already truthy) — writing the frame frame-schema.mjs's own Hidden/
 * Edited/Retracted shapes ask for. `redact` accumulates the CURRENT set of
 * hiders (frame-schema.mjs's own `by`: "the current set of handles hiding
 * it") by reading the target's own last "hidden" frame first
 * (message-index.mjs's `currentHiddenBy`) rather than ever overwriting it —
 * several reactors, or the same one twice, never lose each other; the last
 * hider un-reacting leaves `by: []` (visible again, RX2). The target frame
 * itself is NEVER touched — every one of these three is an ADDITIVE
 * house frame layered on top, matching the record's own one-verbatim-copy
 * rule. @param {{RUNS: string}} deps
 * @param {import("./route.mjs").RouteAction} action a `redact`/`edited`/`retracted` action */
export function applyMetaFrameAction({ RUNS }, action) {
  const framesPath = join(RUNS, /** @type {any} */ (action).roomId, "frames.jsonl");
  if (action.kind === "redact") {
    const current = currentHiddenBy(framesPath, action.target);
    const by =
      action.action === "add"
        ? current.includes(action.by)
          ? current
          : [...current, action.by]
        : current.filter((h) => h !== action.by);
    appendHouseFrame(framesPath, { type: "hidden", target: action.target, by });
    return;
  }
  if (action.kind === "edited") {
    appendHouseFrame(framesPath, {
      type: "edited",
      target: action.target,
      text: action.text,
      ...(action.edited_at ? { edited_at: action.edited_at } : {}),
    });
    return;
  }
  if (action.kind === "retracted") {
    appendHouseFrame(framesPath, { type: "retracted", target: action.target });
  }
}

/** @param {import("./route.mjs").RouteAction} a
 * @returns {a is {kind: "redact"|"edited"|"retracted", roomId: string, target: number}} */
export function isMetaFrameAction(a) {
  return a.kind === "redact" || a.kind === "edited" || a.kind === "retracted";
}

/** every platform id known for this being, learned once at seat start (or
 * again, idempotently, whenever a later hello/initialize brings a NEW one
 * — harness-port W6-R1, 2026-09-19) — rechristen (identity-map.mjs) makes
 * each one the canonical handle for THAT platform id going forward.
 * Extracted from seat.mjs's own start() (2026-09-17, mission task 1) to
 * keep that file under its own line-length ratchet. `number_id`
 * (harness-port W5-A: seat.mjs derives it from `number_env` at seat
 * start) is the fallback for a platform with no `being_id` of its own —
 * Signal today; `self_uuid` (W6-R1: mcpl-signal's own announced uuid,
 * seat.mjs's own poll sets it) is a THIRD id the very same account can
 * be addressed by — a Signal mention carries the uuid, never the number.
 * `self_id` (W6-R5: Discord's own being-hosted seat carries no
 * `being_id` of its own — the house never sees its child's stderr — so
 * its account id rides here instead) is a FOURTH. `ids` defaults to
 * cfg's own four id fields, each paired with its own kind name for the
 * success log below (harness-port 28-reattach-gaps), but takes any
 * explicit list (tests; a caller with ids from elsewhere) — every falsy
 * entry skipped, every other one christened, never just the first found.
 * @param {{platform: string, being_id?: string|null, number_id?: string|null,
 *   self_uuid?: string|null, self_id?: string|null, being: string}} cfg
 * @param {(args: {platform: string, id: string, display: string|null}) => {handle: string}} identityFor
 * @param {(from: string, to: string) => void} rechristen
 * @param {(line: string) => void} say
 * @param {[string, string|null|undefined][]} [ids] `[kind, platformId]` pairs */
export function christenBeing(
  cfg,
  identityFor,
  rechristen,
  say,
  ids = [
    ["being_id", cfg.being_id],
    ["number_id", cfg.number_id],
    ["self_uuid", cfg.self_uuid],
    ["self_id", cfg.self_id],
  ],
) {
  for (const [kind, platformId] of ids) {
    if (!platformId) continue;
    try {
      const who = identityFor({ platform: cfg.platform, id: platformId, display: cfg.being });
      if (who.handle !== cfg.being) {
        rechristen(who.handle, cfg.being);
        // a success-path line so the log can answer "did it run" — ids kept
        // out of it besides a short suffix (harness-port 28-reattach-gaps).
        say(`christened @${cfg.being} as ${cfg.platform}:${kind} (…${String(platformId).slice(-4)})`);
      }
    } catch (e) {
      say(`could not christen the being's platform id ${platformId}: ${e.message}`);
    }
  }
}

/** seat.mjs's own 250ms poll (W6-R1/W6-R5, extracted here 2026-09-19 to
 * keep seat.mjs under its own line-length ratchet): `host.state.self`
 * (mcpl/child.mjs or remote-host.mjs, either shared shape) arrives on its
 * own schedule, not only at seat start — Signal's `{uuid,numberId}` or
 * Discord's `{id}` (no `channels/self` of its own) both read through the
 * same key, so whichever field a platform actually carries still fires
 * a re-christen the moment it's new; a repeat call costs nothing once
 * caught up (identityFor/rechristen are no-ops once already mapped).
 * @param {{cfg: {self_uuid?: string|null, self_id?: string|null}, host: {state: {self: any}},
 *   identityFor: Function, rechristen: Function, say: (line: string) => void}} deps
 * @returns {() => void} the poll function seat.mjs calls every tick */
export function createSelfTracker({ cfg, host, identityFor, rechristen, say }) {
  let lastKey = null;
  return function checkSelf() {
    const self = host.state.self;
    if (!self) return;
    const key = `${self.uuid ?? ""}|${self.id ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;
    if (self.uuid) cfg.self_uuid = self.uuid;
    if (self.id) cfg.self_id = self.id;
    christenBeing(cfg, identityFor, rechristen, say);
  };
}

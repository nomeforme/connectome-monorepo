// @ts-check
/* connectome-house/src/serve-rooms.mjs — a room: a standing place on a
 * platform (a Discord channel, a Signal group, a Signal DM), held here as
 * ONE record — opened once, reopened as a new session every time the
 * platform brings it back to life. `class.json.room = {platform, stream,
 * title, opened_t}`; the run id never carries the raw stream (a Signal
 * DM's stream can be a phone number) — `roomSlug` (serve-room-open.mjs).
 *
 * `openRoom` is the keyed open/reopen the house's own platform seat calls
 * IN-PROCESS: no HTTP request in sight, so no mayTouch/mayView gating
 * inside it — the caller (the platform seat, or this file's own
 * keeper-gated HTTP handlers below) already decided who may act.
 * `roomInput` is the matching in-process way a platform message reaches
 * an open room's record.
 *
 * Ported from a private deployment (2026-09-17): the source's `openRoom`
 * minted a room by spawning a specific CLI walk-child (`startWalk`) and
 * reopened one via a loom/fork subsystem (`reopenRun`) — both cut per
 * this port's target architecture (a room here is a record plus an
 * optional attached being's-turn seat, docs/harness-port/
 * 03-house-design.md §1-2; no child process, no CLI argv). What's kept is
 * the room-record shape and lifecycle (mint / reopen / rest) reimplemented
 * directly against trace.mjs + open-rooms.mjs's registry. Actually
 * DELIVERING a turn to a being is `open-rooms.mjs`'s `attachSeat` hook —
 * a room here always accepts and records input whether or not a being is
 * currently seated to answer it.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PRIVATE_DIR, RUNS } from "./serve-paths.mjs";
import { body, json } from "./serve-http.mjs";
import { mayView, scopeOfDir, whoAmI } from "./serve-identity.mjs";
import { isStanding, readCls, writeCls } from "./room-policy.mjs";
import { HANDLE_RE, knownHandle, testamentFor } from "./testaments.mjs";
import { identityKnown } from "./identity-map.mjs";
import { beingsFromParticipants, beingsOf } from "./beings.mjs";
import { compileRoomLives, roomRecord, roomSlug, widenRoomParticipants } from "./serve-room-open.mjs";
import { openTrace } from "./trace.mjs";
import { appendHouseFrame } from "./frames-io.mjs";
import { attachAllToRun, resolveAttachments } from "./serve-attachments.mjs";
import { sendLine, sendParticipant } from "./seat/protocol.mjs";
import { findRoom, rememberRoom, scanRooms } from "./room-index.mjs";
import { attachRegisteredSeat, open, lifecycleLock, lifecycleUnlock } from "./open-rooms.mjs";
import { decideActivation, mentionsIn } from "./dispatch.mjs";
import { covenantFor } from "./resident-covenant.mjs";
import { beginTurn } from "./room-turn.mjs";
import { appendPeriod, lifeForHandle } from "./resident-life.mjs";

export { findRoom };

/** @typedef {{platform:string, stream:string, title?:string|null,
 *   beings:string[], who?:{handle:string,home?:string}|null,
 *   visibility?:string, mock?:boolean}} RoomOpenOpts */

/** the platform's own name for a room, learned after it may already
 * exist: refresh class.json.room.title AND the matching
 * class.json.question in place when `title` differs from what's stored.
 * A no-op with no title, or one matching what's already there; never
 * downgrades a known title to null. The record's own frames are
 * untouched — this is metadata, not a frame. */
function refreshRoomTitle(runDir, title) {
  if (!title) return;
  const cls = readCls(runDir);
  if (cls.room?.title === title) return;
  cls.room = { ...cls.room, title };
  cls.question = `A room opened: ${title}`;
  writeCls(runDir, cls);
}

/* `resolveAttachments`/`attachAllToRun` moved to serve-attachments.mjs
 * (harness-port W1, this task's own extraction — this file's inline copy
 * was itself a comment admitting the duplication: "out of scope as its
 * own module"; it's now a module, shared with serve-media-upload.mjs). */

/** the closed record: `open`'s scope shape from a class.json. */
function scopeFor(cls) {
  return {
    visibility: cls.visibility ?? "public",
    owner: cls.owner ?? null,
    participants: (cls.participants ?? []).filter((p) => !p.pending).map((p) => p.handle),
  };
}

/** ensure `id` is tracked in the `open` registry — from an in-memory rec
 * if this process already has one, else freshly read off disk (the
 * common case right after a process restart: the record persists, the
 * in-memory registry doesn't). Never creates a new record. */
function ensureRegistered(id) {
  const existing = open.get(id);
  if (existing) return existing;
  const runDir = join(RUNS, id);
  const cls = readCls(runDir);
  const rec = {
    id,
    runDir,
    cls,
    status: "open",
    scope: scopeFor(cls),
    standing: true,
    seat: null,
    framesOffset: 0,
  };
  open.set(id, rec);
  attachRegisteredSeat(rec); // a being's already-live seat elsewhere may already belong here (W4-A)
  return rec;
}

/** stream key -> the in-flight openRoom call resolving it */
const inflight = /** @type {Map<string, Promise<any>>} */ (new Map());

/** open (or reopen) a room keyed by {platform, stream} — never mints
 * twice for the same stream. A LIVE match returns as-is; a rested/
 * aborted match (or one this process hasn't seen since restart) reopens
 * in place; no match mints one. Concurrent opens of the SAME stream share
 * one in-flight promise, never a 409.
 * @param {RoomOpenOpts} opts */
export async function openRoom(opts) {
  const key = `room:${opts.platform}:${opts.stream}`;
  const already = inflight.get(key);
  if (already) return already;
  const p = (async () => {
    if (!lifecycleLock(key))
      return { error: "this room is already being opened — one moment", code: 409 };
    try {
      return await openRoomLocked(opts);
    } finally {
      lifecycleUnlock(key);
    }
  })();
  inflight.set(key, p);
  p.finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  return p;
}

/** the lock-held body of openRoom. @param {RoomOpenOpts} opts */
async function openRoomLocked({ platform, stream, title = null, beings, who, visibility }) {
  const existing = findRoom({ platform, stream });
  if (existing) {
    const runDir = join(RUNS, existing.id);
    refreshRoomTitle(runDir, title);
    const rec = ensureRegistered(existing.id);
    if (rec.status === "open") return { id: existing.id, state: "live" };
    rec.status = "open";
    rec.cls = readCls(runDir);
    rec.scope = scopeFor(rec.cls);
    await compileRoomLives({ runDir, cls: rec.cls });
    attachRegisteredSeat(rec); // a room reopened after its being's seat attached elsewhere
    return { id: existing.id, state: "reopened" };
  }
  const primary = beings?.[0] ?? null;
  if (primary && !knownHandle(primary)) return { error: "unknown being", code: 400 };
  if (primary && !testamentFor(primary)?.covenant?.speaks_for)
    return { error: `@${primary} has no voice on this box (speaks_for is unset)`, code: 409 };

  const id = randomUUID();
  const runDir = join(RUNS, id);
  mkdirSync(runDir, { recursive: true });
  const openedAt = new Date().toISOString();
  const participants = [];
  widenRoomParticipants(participants, beings, openedAt);
  const cls = {
    // a platform room is a wondering with a place, not its own class.
    class: "wondering",
    question: title ? `A room opened: ${title}` : `A room opened on ${platform}.`,
    owner: who?.handle ?? primary ?? "Keeper",
    owner_home: who?.home ?? null,
    visibility: visibility === "private" ? "private" : "public",
    being: primary,
    beings: beingsFromParticipants(participants),
    participants,
    // a fresh mint keeps the raw stream — canonicalStream is a lookup
    // concern only (room-index.mjs's findRoom), never a rewrite at birth.
    room: roomRecord({ platform, stream, title }, openedAt),
  };
  const trace = await openTrace(runDir);
  trace.frame("room.mounted", { platform, substrate: trace.substrate, run: id });
  writeCls(runDir, cls);
  await compileRoomLives({ runDir, cls });
  open.set(id, {
    id,
    runDir,
    cls,
    status: "open",
    scope: scopeFor(cls),
    standing: true,
    seat: null,
    framesOffset: 0,
  });
  attachRegisteredSeat(open.get(id)); // a room opened after its being's seat attached elsewhere
  rememberRoom({ id, platform, stream }); // the index knows it before RUNS's next rescan
  return { id, state: "opened" };
}

/** runDir -> its "<platform>:<message_id>" ids, kept CURRENT — a byte
 * offset (never "read once") tracks how far external.jsonl has been
 * parsed, since OTHER writers append after the Set is first built. Grown
 * -> parse only the new bytes; shrunk or a different inode -> rebuild. */
const externalSets = /** @type {Map<string, {set: Set<string>, offset: number, ino: number}>} */ (
  new Map()
);

function parseExternalRows(set, text) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.platform && row.message_id) set.add(`${row.platform}:${row.message_id}`);
    } catch {
      /* a truncated/corrupt row — never fatal to the rest */
    }
  }
}

function externalSetFor(runDir) {
  const p = join(runDir, "external.jsonl");
  let st;
  try {
    st = statSync(p);
  } catch {
    externalSets.delete(runDir);
    return new Set();
  }
  let entry = externalSets.get(runDir);
  if (entry && (entry.ino !== st.ino || st.size < entry.offset)) entry = undefined;
  if (!entry) {
    entry = { set: new Set(), offset: 0, ino: st.ino };
    externalSets.set(runDir, entry);
  }
  if (st.size === entry.offset) return entry.set;
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(st.size - entry.offset);
    readSync(fd, buf, 0, buf.length, entry.offset);
    const text = buf.toString("utf8");
    const cut = text.lastIndexOf("\n");
    if (cut === -1) return entry.set; // no complete line landed yet in the new bytes
    parseExternalRows(entry.set, text.slice(0, cut));
    entry.offset += Buffer.byteLength(text.slice(0, cut + 1), "utf8");
  } finally {
    closeSync(fd);
  }
  return entry.set;
}

/** has `{platform, message_id}` already landed here, either direction? Two
 * seats in one room each receive the SAME message; a being's own speech
 * echoes back the same way — both collapse to: seen once, kept once. */
function externalAlreadyRecorded(runDir, platform, message_id) {
  if (!message_id) return false;
  return externalSetFor(runDir).has(`${platform}:${message_id}`);
}

/** house-internal: a room's message from the platform seat — never HTTP,
 * so no mayTouch/mayView here (the platform seat already decided this
 * message belongs in this room). `by` is a handle the house knows
 * (identity-map.mjs's `identityKnown`). `external` is kept in a per-run
 * external.jsonl sidecar (frame-schema.mjs's Frame is a closed union) —
 * only `platform`, `message_id`, `reply_to`, and a hash of `text` (never
 * the text itself) land there. `targets`/`observe` are the house's own
 * activation decision (mcpl/route.mjs's `decideActivation`), carried onto
 * the room's record and, when a being's seat is attached, onto its line.
 * A message this run already recorded under `external.message_id` is a
 * no-op: `{ok: true, duplicate: true}`.
 * @param {{id:string, by:string, home?:string|null, text:string,
 *   external?: {platform:string, message_id?:string, reply_to?:string},
 *   targets?: string[], observe?: boolean, attachments?: string[]}} opts
 */
export async function roomInput({
  id,
  by,
  home = null,
  text,
  external,
  targets,
  observe,
  attachments,
}) {
  if (!HANDLE_RE.test(by)) return { error: "not a known handle shape", code: 400 };
  if (!identityKnown(by)) {
    return { error: "not a handle the house knows", code: 400 };
  }
  const runDir = join(RUNS, id);
  if (!existsSync(join(runDir, "class.json"))) return { error: "no such room", code: 404 };
  const rec = ensureRegistered(id);
  if (rec.status !== "open") return { error: "this room is not open", code: 409 };
  if (external && externalAlreadyRecorded(runDir, external.platform, external.message_id))
    return { ok: true, duplicate: true };
  const att = resolveAttachments(attachments);
  if (!att.ok) return { error: att.error, code: 400 };
  attachAllToRun(att.attachments, id);
  const cls = readCls(runDir);
  rec.cls = cls; // keep the in-memory rec current — beginTurn's own render reads rec.cls
  const already = (cls.participants ?? []).some((p) => p.handle === by && !p.pending);
  if (!already) addParticipant(runDir, id, by, home, "room", "human");

  // a caller that already computed activation (an MCPL platform seat, via
  // mcpl/route.mjs's own routeIncoming) passes targets/observe explicitly;
  // a direct entry (the generic HTTP door, a being's-turn seat's own room,
  // a test) doesn't, so decide it HERE — once, per docs/harness-port/
  // 03-house-design.md §1: "roomInput...decides activation for each
  // seated being". Scoped to this port's one-seat-per-room model
  // (open-rooms.mjs): only the roster is consulted, never a second
  // decision path for the being that actually holds the seat.
  let effTargets = targets;
  let effObserve = observe;
  if (effTargets === undefined) {
    const roster = beingsOf(cls);
    const decided = [];
    for (const handle of roster) {
      const covenant = covenantFor(handle);
      if (!covenant) continue; // no testament at all — never a dispatch participant
      const decision = decideActivation({
        being: { handle, awake: true },
        covenant,
        message: {
          by,
          text,
          mentions: mentionsIn(text, roster),
          reply_to: external?.reply_to ?? null,
          kind: "channel",
          by_kind: testamentFor(by) ? "resident" : "human",
        },
        room: { beings: roster, humans_present: 1, bot_mention_streak: 0 },
      });
      if (decision.activate) decided.push(handle);
    }
    effTargets = decided;
    effObserve = decided.length === 0;
  }
  if (external) {
    // a hash, never the text (the record's one-verbatim-copy rule) — lets
    // a persistent reader recognize this frame as platform-origin by
    // content, not just by who ever sent anything here.
    const trimmed = String(text ?? "").trim();
    appendFileSync(
      join(runDir, "external.jsonl"),
      `${JSON.stringify({
        t: new Date().toISOString(),
        direction: "in",
        platform: external.platform,
        message_id: external.message_id,
        author: by,
        ...(trimmed ? { text_sha: createHash("sha256").update(trimmed).digest("hex") } : {}),
        ...(external.reply_to ? { reply_to: external.reply_to } : {}),
      })}\n`,
    );
    if (external.message_id)
      externalSetFor(runDir).add(`${external.platform}:${external.message_id}`);
  }
  // the house is the only writer of the record (docs/harness-port/
  // 03-house-design.md §1): this message lands as a frame whether or not
  // a being's seat is currently attached to answer it.
  appendHouseFrame(join(runDir, "frames.jsonl"), {
    type: "message",
    by,
    text,
    ...(effTargets?.length ? { to: effTargets } : {}),
  });
  // a seated being that activated gets a turn (its rendered context already
  // carries this very message, just appended above — never a `line` too);
  // a seated being that DIDN'T activate gets the line, observe-only, no
  // turn (house-design.md's mission: "idle lines reach a seated being that
  // is not activated as observe-only context").
  let turnStarted = false;
  if (rec.seat && effTargets?.includes(rec.seat.being)) {
    try {
      beginTurn(rec, rec.seat.being).catch((e) =>
        console.error(`[room] turn for @${rec.seat?.being} in ${id} settled oddly: ${e.message}`),
      );
      turnStarted = true;
    } catch (e) {
      // a turn already in flight (this room's one seat can hold only one at
      // a time) — fall through to the observe-only line rather than lose
      // the message or crash the caller.
      console.error(`[room] beginTurn refused for @${rec.seat.being} in ${id}: ${e.message}`);
    }
  }
  if (rec.seat && !turnStarted) {
    sendLine(rec, { by, text, targets: effTargets, observe: effObserve, attachments: att.attachments });
  }
  return { ok: true };
}

/** add `handle` as an accepted participant (idempotent); update the open
 * rec's scope; notify an attached seat, or append directly to the record
 * when none is attached. Inlined, trimmed: the source's own
 * serve-participants.mjs also compiled a joining being's life and
 * re-seated it mid-run (product-shaped orchestration cut from this
 * port — `openRoom`/`compileRoomLives` already compile every present
 * being's life at open/reopen time). */
export function addParticipant(runDir, id, handle, home, via, kind) {
  const cls = readCls(runDir);
  cls.participants ??= [];
  const existing = cls.participants.find((x) => x.handle === handle);
  if (existing && !existing.pending) return { ok: true, already: true };
  const k = kind === "walker" || kind === "resident" ? kind : (existing?.kind ?? "human");
  if (existing) {
    delete existing.pending;
    existing.joined_t = new Date().toISOString();
    if (via) existing.via = via;
    if (k !== "human") existing.kind = k;
  } else {
    cls.participants.push({
      handle,
      home: home ?? null,
      joined_t: new Date().toISOString(),
      ...(via ? { via } : {}),
      ...(k !== "human" ? { kind: k } : {}),
    });
  }
  cls.beings = beingsFromParticipants(cls.participants);
  writeCls(runDir, cls);
  const rec = open.get(id);
  if (rec) {
    rec.cls = cls;
    rec.scope = scopeFor(cls);
    if (rec.seat) sendParticipant(rec, { handle, participantKind: k });
    else if (k !== "human") attachRegisteredSeat(rec); // newly-added being may already be seated elsewhere
  } else {
    appendFileSync(
      join(runDir, "frames.jsonl"),
      `${JSON.stringify({
        t: new Date().toISOString(),
        type: "participant.joined",
        handle,
        ...(k !== "human" ? { kind: k } : {}),
      })}\n`,
    );
  }
  return { ok: true };
}

/** one room's listing row — GET /api/rooms and GET /api/rooms/:platform/:slug8
 * share this shape; `stream` is stripped for a non-keeper caller (it may
 * carry a phone number for a Signal DM). */
function roomRow(dir, id, { includeStream }) {
  const cls = readCls(dir);
  const run = existsSync(join(dir, "run.json"))
    ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))
    : null;
  const rec = open.get(id);
  const framesPath = join(dir, "frames.jsonl");
  return {
    id,
    platform: cls.room?.platform ?? null,
    ...(includeStream ? { stream: cls.room?.stream ?? null } : {}),
    title: cls.room?.title ?? null,
    beings: beingsOf(cls),
    state: rec ? rec.status : (run?.state ?? "aborted"),
    sessions: Array.isArray(run?.sessions) ? run.sessions.length : 0,
    last_activity: existsSync(framesPath) ? statSync(framesPath).mtime.toISOString() : null,
    visibility: cls.visibility ?? "public",
  };
}

/** POST /api/rooms/open — keeper (or house-internal — the platform seat
 * calls `openRoom` directly, never this route) only. */
export async function handleRoomsOpen(req, res) {
  const who = whoAmI(req);
  if (!who.roles.includes("keeper"))
    return json(res, 403, { error: "opening a room is a keeper (or house-internal) act" });
  const b = await body(req);
  const platform = String(b.platform ?? "").trim();
  const stream = String(b.stream ?? "").trim();
  if (!platform || !stream) return json(res, 400, { error: "platform and stream are required" });
  const beings = Array.isArray(b.beings) ? b.beings.filter((s) => HANDLE_RE.test(String(s))) : [];
  if (!beings.length) return json(res, 400, { error: "at least one being is required" });
  const r = await openRoom({
    platform,
    stream,
    title: typeof b.title === "string" && b.title.trim() ? b.title.trim() : null,
    beings,
    who: { handle: beings[0], home: typeof b.home === "string" ? b.home : undefined },
    visibility: b.visibility === "private" ? "private" : "public",
  });
  return json(res, r.error ? (r.code ?? 409) : 200, r);
}

/** GET /api/rooms — every room this box holds; public listing strips
 * `stream` and any room a keeper alone may view. */
export function handleRoomsList(req, res) {
  const who = whoAmI(req);
  const isKeeper = who.roles.includes("keeper");
  if (!existsSync(RUNS)) return json(res, 200, { rooms: [] });
  const rooms = [];
  for (const d of readdirSync(RUNS)) {
    const dir = join(RUNS, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "class.json"))) continue;
      const cls = readCls(dir);
      if (!isStanding(cls)) continue;
      if (!isKeeper && !mayView(who, scopeOfDir(dir))) continue;
      rooms.push(roomRow(dir, d, { includeStream: isKeeper }));
    } catch {
      /* unreadable class.json — not ours to list */
    }
  }
  return json(res, 200, { rooms });
}

/** GET /api/rooms/:platform/:slug8 — any run whose class.json carries a
 * place matching platform+slug8, whatever its class or id shape. */
export function handleRoomGet(req, res, match) {
  const [, platform, slug8] = match;
  const hit = scanRooms().find((r) => r.platform === platform && roomSlug(r.stream) === slug8);
  if (!hit) return json(res, 404, { error: "no such room" });
  const dir = join(RUNS, hit.id);
  const who = whoAmI(req);
  if (!mayView(who, scopeOfDir(dir))) return json(res, 403, { error: "this room is private" });
  return json(res, 200, roomRow(dir, hit.id, { includeStream: who.roles.includes("keeper") }));
}

/** POST /api/rooms/:id/rest — keeper (or house-internal) only: the gentle
 * close a room's reopen cycle depends on. The record stays; the room
 * simply stops accepting `roomInput` until its next open/reopen. */
export async function handleRoomRest(req, res, match) {
  const who = whoAmI(req);
  if (!who.roles.includes("keeper"))
    return json(res, 403, { error: "resting a room is a keeper (or house-internal) act" });
  const id = match[1];
  const rec = open.get(id);
  if (!rec) return json(res, 409, { error: "not an open room" });
  if (!isStanding(readCls(rec.runDir))) return json(res, 400, { error: "not a room" });
  await restRoom(rec);
  return json(res, 200, { ok: true });
}

/** rest an open room in place: append a `rested` frame, record a session
 * boundary in run.json, flip the registry's status, and let every present
 * being's own life gain this session's period (resident-life.mjs's
 * `appendPeriod` — never wired into a live server path in this port until
 * now; a rest is exactly the session boundary it was built to close over).
 * A being with no compiled life, or whose append fails, is logged, never
 * a reason to refuse the rest itself — the record's own `rested` frame
 * above already stands regardless. Awaited (not fire-and-forget) so a
 * caller that wants to confirm "the life gained a period" can simply
 * await this call, matching resident-life-sessions.test.mjs's own
 * pattern. */
export async function restRoom(rec) {
  const framesPath = join(rec.runDir, "frames.jsonl");
  if (existsSync(framesPath)) {
    let seq = 0;
    try {
      const lines = readFileSync(framesPath, "utf8").split("\n").filter(Boolean);
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      seq = (last?.seq ?? -1) + 1;
    } catch {
      /* an unreadable tail still gets a rest frame, at a best-guess seq */
    }
    appendFileSync(
      framesPath,
      `${JSON.stringify({ seq, t: new Date().toISOString(), type: "rested" })}\n`,
    );
  }
  const runJsonPath = join(rec.runDir, "run.json");
  let run = { sessions: [] };
  try {
    if (existsSync(runJsonPath)) run = JSON.parse(readFileSync(runJsonPath, "utf8"));
  } catch {
    /* a corrupt run.json is replaced, never blocks the rest */
  }
  run.sessions = Array.isArray(run.sessions) ? run.sessions : [];
  run.sessions.push({ rested_t: new Date().toISOString() });
  run.state = "rested";
  writeFileSync(runJsonPath, JSON.stringify(run, null, 2));
  rec.status = "rested";

  const cls = rec.cls ?? readCls(rec.runDir);
  for (const handle of beingsOf(cls)) {
    try {
      const life = await lifeForHandle(handle);
      if (life) await appendPeriod(life, rec.runDir, { privateRoot: PRIVATE_DIR });
    } catch (e) {
      console.error(`[life] appendPeriod failed for @${handle} in ${rec.id ?? rec.runDir}: ${e.message}`);
    }
  }
}

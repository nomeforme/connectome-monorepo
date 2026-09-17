// @ts-check
/* connectome-house/src/mcpl/seat.mjs — ONE server's seat: host → route →
 * in-process calls (openRoom, roomInput, storeInboundAttachments), and
 * back: tails each owned room's frames.jsonl, and on a final `message`/
 * `media.attached` or an app-typed line (relay.mjs), speaks through the
 * server's own tools, split/sized per platform, each id written to
 * external.jsonl. A Request is answered at once (turn minted, typing on —
 * turns.mjs), applied after on the seat's own chain. One server = one bot
 * = one `being`; another being's output is not carried — logged once.
 *
 * Ported from a private deployment (2026-09-17): three subsystems that
 * source wired in here are cut from this port (house-design.md's list of
 * what a being-container keeps, not the house) — a wake/sleep alarm
 * clock (alarm-store.mjs: `awakeOf` below always reads a being as awake),
 * a keeper-notification inbox (serve-notify.mjs: `isKeeper` below reads a
 * plain HOUSE_KEEPERS allowlist instead), and a sleeping-resident
 * "threshold receipt" acknowledgement (serve-threshold.mjs: stubbed
 * below, never fires while `awakeOf` is always true). */
import { join } from "node:path";
import { beingsOf } from "../beings.mjs";
import { identityFor, rechristen } from "../identity-map.mjs";
import { roomPostureFor } from "../resident-covenant.mjs";
import { RUNS } from "../serve-paths.mjs";
import { addParticipant } from "../serve-rooms.mjs";
import { readCls } from "../room-policy.mjs";
import { roomSlug } from "../serve-room-open.mjs";
import {
  findRoom,
  openRoom as defaultOpenRoom,
  roomInput as defaultRoomInput,
} from "../serve-rooms.mjs";
import { hydrateSpeech, tailFrames } from "../frames-io.mjs";
import { open } from "../open-rooms.mjs";
import { testamentFor } from "../testaments.mjs";
import { adapterFor } from "./adapters.mjs";
import { createHost } from "./host.mjs";
import { createLinkGate } from "./link.mjs";
import { storeInboundAttachments } from "./media-in.mjs";
import { createPark } from "./park.mjs";
import { createReplyQueue, providerErrorNotice } from "./outbound.mjs";
import { createRedeliverWatcher } from "./redeliver.mjs";
import { createRelay, tooOldToRelay } from "./relay.mjs";
import { createRoomTails } from "./room-tails.mjs";
import { routeIncoming } from "./route.mjs";
import { noteSelfDisplay, selfDisplayFor } from "./self-display.mjs";
import { createSpeaker } from "./speak.mjs";
import { sweepHistory } from "./sweep.mjs";
import { createTurns } from "./turns.mjs";

const POLL_MS = 250;

// life-entries.mjs's own taxonomy: a turn that left no speech behind.
const NO_SPEECH_ENDING = new Set(["rested", "dissolved", "aborted", "error"]);

/** @param {{server: import("./config.mjs").ServerConfig, log?: (line: string) => void,
 *   otherBotIds?: Set<string>, hostOpts?: object, roomInput?: typeof defaultRoomInput,
 *   openRoom?: typeof defaultOpenRoom, parkRetryMs?: number}} opts */
export function createSeat({
  server: cfg,
  log = console.error,
  otherBotIds,
  hostOpts = {},
  roomInput = defaultRoomInput,
  openRoom = defaultOpenRoom,
  parkRetryMs,
}) {
  const say = (line) => log(`[seat:${cfg.name}] ${line}`);
  // a queued id answers the NEXT speech in the room, so a turn that ends
  // without one (see NO_SPEECH_ENDING below) must let its id go first.
  const pendingReply = createReplyQueue();
  const streaks = new Map();
  const stats = {
    inputs: 0,
    receipts: 0,
    blobs: 0,
    sent: 0,
    undelivered: 0,
    failed: 0,
    ignored: {},
    lastIncomingAt: null,
  };
  const inferenceRequests = [];
  const voiceless = new Set();
  const adapter = adapterFor(cfg.platform);
  /** another being's output has no voice here — logged once per handle. */
  function noteVoiceless(by, stream, what) {
    if (typeof by !== "string" || by === "house" || voiceless.has(by)) return;
    voiceless.add(by);
    say(`@${by} ${what} in ${stream}; this seat speaks only for @${cfg.being} — not carried`);
  }

  // the bot's own display name (history or a live echo matching being_id) —
  // self-display.mjs holds it for the inbound rewrite and the surface.
  function learnSelfDisplay(msg) {
    if (cfg.being_id && msg?.author?.id === cfg.being_id)
      noteSelfDisplay(cfg.platform, cfg.being, msg.author.name);
  }

  // one message applied at a time — racing openRoom for one stream would mint twice.
  let chain = Promise.resolve();
  const host = createHost({
    server: cfg,
    log,
    onIncoming,
    onHistory: async (channelId, messages) => {
      for (const m of messages) learnSelfDisplay(m);
      await sweepHistory(
        { roomsOpen, apply, houseLine, say, RUNS, routeDeps },
        channelId,
        messages,
      );
    },
    onInferenceRequest: (params) => {
      inferenceRequests.push({ t: new Date().toISOString(), params });
      if (inferenceRequests.length > 20) inferenceRequests.shift();
    },
    ...hostOpts,
  });
  const turns = createTurns({
    name: cfg.name,
    being: cfg.being,
    host,
    roomIdOf: (stream) => roomsOpen(stream)?.id ?? null,
    say,
  });
  const { speak, speakMedia, houseLine } = createSpeaker({ cfg, host, stats, say, RUNS });
  const relay = createRelay({ readCls }); // a third outbound path: app-typed lines

  /* ---------- the injected lookups the pure router needs ---------- */
  function roomsOpen(stream) {
    const found = findRoom({ platform: cfg.platform, stream });
    if (!found) return null;
    const runDir = join(RUNS, found.id);
    let beings = [];
    try {
      beings = beingsOf(readCls(runDir)); // unreadable class.json: no roster
    } catch {}
    return { id: found.id, beings, live: open.get(found.id)?.status === "open" };
  }
  const roomKeyOf = (stream) => `${cfg.platform}:${roomSlug(stream)}`;
  // no wake/sleep alarm clock in this port (see the module header) — every
  // being reads as awake; dispatch.mjs's own posture/dispatch gates still
  // apply apart from this.
  const awakeOf = () => true;
  const isBeing = (handle) => !!testamentFor(handle);
  // a plain allowlist in place of the source's product-side keeper-account
  // lookup (see the module header) — comma-separated handles.
  const keeperHandles = () =>
    String(process.env.HOUSE_KEEPERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  /** routeIncoming's own deps, shared by the live path and the sweep. */
  const routeDeps = () => ({
    server: { ...cfg, displayName: selfDisplayFor(cfg.platform, cfg.being) },
    roomsOpen,
    identityFor,
    isBeing,
    covenants: roomPostureFor,
    roomKeyOf,
    awakeOf,
    isKeeper: (h) => keeperHandles().includes(h),
  });

  const { tails, trackRoom, ensureLive } = createRoomTails({ cfg, RUNS, openRoom, roomsOpen });
  const park = createPark({ apply, say, retryMs: parkRetryMs });
  const redeliver = createRedeliverWatcher({ cfg, host, say });
  const linkGate = createLinkGate({
    platform: cfg.platform,
    appUrl: cfg.app_url ?? null,
    adapter,
    identityFor,
    isKeeper: (h) => keeperHandles().includes(h),
    otherBotIds,
    host,
    say,
  });

  /* ---------- inbound: route, answer, then apply ---------- */
  /** the server's answer, at once; the apply rides the chain behind it */
  function onIncoming(msg) {
    stats.lastIncomingAt = new Date().toISOString();
    learnSelfDisplay(msg);
    const gate = linkGate.intercept(msg);
    if (gate) {
      stats.ignored[gate.reason] = (stats.ignored[gate.reason] ?? 0) + 1;
      return Promise.resolve({ accepted: false, reason: gate.reason });
    }
    const actions = routeIncoming({ ...routeDeps(), msg, streakOf: (s) => streaks.get(s) ?? 0 });
    const ignored = actions.find((a) => a.kind === "ignore");
    if (ignored) {
      stats.ignored[ignored.reason] = (stats.ignored[ignored.reason] ?? 0) + 1;
      return Promise.resolve({ accepted: false, reason: ignored.reason });
    }
    const input = actions.find((a) => a.kind === "input");
    const stream = input?.stream ?? actions[0]?.stream ?? null;
    const known = stream ? roomsOpen(stream) : null;
    let inferenceId = null;
    for (const being of input?.targets ?? []) inferenceId = turns.begin(stream, being);
    chain = chain
      .then(() => park.guarded(msg, actions, stream))
      .catch((e) => {
        stats.failed += 1;
        say(`could not apply ${msg.messageId ?? "a message"} in ${stream}: ${e.message}`);
        for (const being of input?.targets ?? []) turns.end(stream, being, "failed");
        turns.stopTyping(stream, "apply failed");
      });
    return Promise.resolve({ accepted: true, conversationId: known?.id ?? null, inferenceId });
  }

  async function apply(msg, actions) {
    let roomId = null;
    // stored attachments ride the `input` action below, never a house frame.
    /** @type {import("./media-in.mjs").StoredAttachment[]} */
    const attachments = [];
    for (const a of actions) {
      if (a.kind === "open-room") {
        roomId = await ensureLive(a.stream, { title: a.title, beings: a.beings });
        continue;
      }
      // an already-open room's next ensureLive still carries route.mjs's
      // own roomTitle — a rename refreshes on the room's very next message.
      roomId ??= await ensureLive(a.stream, { title: a.roomTitle ?? null });
      const runDir = join(RUNS, roomId);
      if (a.kind === "share-blob") {
        const opts = { platform: cfg.platform, runId: roomId, log: say };
        const blob = { bytes: a.bytes, mime: a.mime, filename: a.filename };
        for (const s of await storeInboundAttachments([blob], opts)) {
          attachments.push(s);
          relay.markPlatformMedia(roomId, a.by, s.path);
          stats.blobs += 1;
        }
      } else if (a.kind === "receipt") {
        // no sleeping-resident threshold acknowledgement in this port (see
        // the module header) — `awakeOf` always true means route.mjs
        // should never actually emit this action kind, but the branch
        // stays a documented no-op rather than a missing case.
      } else if (a.kind === "input") {
        if (a.notice) linkGate.notifyUnlinkedRoom(msg, a.stream);
        if (a.by_kind !== "human") addParticipant(runDir, roomId, a.by, a.home, "room", a.by_kind);
        const r = await roomInput({
          id: roomId,
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
        // already recorded — another bot's child saw it first, or it's an
        // echo of this being's own speech (chat:from-bot): held once.
        if (r.duplicate) {
          for (const being of a.targets) turns.end(a.stream, being, "completed");
          turns.stopTyping(a.stream, "duplicate");
          continue;
        }
        stats.inputs += 1;
        relay.markPlatformOrigin(roomId, a.by, a.text);
        streaks.set(
          a.stream,
          a.by_kind === "human" ? 0 : (streaks.get(a.stream) ?? 0) + (a.targets.length ? 1 : 0),
        );
        if (msg.messageId)
          for (const being of a.targets) pendingReply.push(roomId, being, msg.messageId);
      }
    }
  }

  /* ---------- outbound: the room's record → the platform (speak.mjs) ---------- */

  function onFrame(roomId, stream, runDir, f) {
    if (NO_SPEECH_ENDING.has(f.type)) {
      pendingReply.clear(roomId);
      turns.stopTyping(stream, "the turn ended without speech");
      // errors as chat messages (keeper), never for `aborted` (a restart);
      // seq rides speak() itself, so a re-seat never posts one twice.
      if (f.type === "error" && cfg.errors_to_chat) {
        const notice = providerErrorNotice(cfg.being, f.message);
        houseLine(roomId, notice);
        void speak(roomId, stream, notice, { by: "house", seq: f.seq });
      }
      return;
    }
    if (f.type === "message") {
      if (tooOldToRelay(f)) {
        houseLine(
          roomId,
          "[an app line from before this seat's catch-up window arrived too late to relay]",
        );
        return;
      }
      const text = relay.textFor(roomId, runDir, f);
      return void (text && speak(roomId, stream, text, { by: f.by, seq: f.seq }));
    }
    // model media: own being goes out, another's is voiceless; human media:
    // app-origin goes out, platform-origin never echoes back (relay's mark).
    if (f.type === "media.attached") {
      if (f.requested_by === "model" && f.by !== cfg.being) {
        noteVoiceless(f.by, stream, "attached media");
        return;
      }
      if (f.requested_by === "human" && relay.isPlatformMedia(roomId, f.by, f.path)) return;
      void speakMedia(roomId, stream, f, { by: f.by, seq: f.seq });
      return;
    }
    if (f.type !== "speech" || f.interim) return;
    if (f.by !== cfg.being) return void noteVoiceless(f.by, stream, "spoke");
    const text = hydrateSpeech(f, runDir).inline;
    if (typeof text !== "string" || !text.trim()) {
      turns.stopTyping(stream, "empty speech");
      return;
    }
    const replyTo = pendingReply.take(roomId, cfg.being);
    turns.end(stream, cfg.being, "completed");
    // typing until the words have landed on the platform, never past them
    void speak(roomId, stream, text, { by: cfg.being, replyTo, seq: f.seq }).then(() =>
      turns.stopTyping(stream, "final speech"),
    );
  }

  function pollTails() {
    redeliver.check(tails);
    for (const [roomId, t] of tails) {
      const { frames, offset } = tailFrames(join(t.runDir, "frames.jsonl"), t.offset);
      t.offset = offset;
      for (const f of frames) onFrame(roomId, t.stream, t.runDir, f);
    }
  }
  const timer = setInterval(pollTails, POLL_MS);
  timer.unref();

  /* ---------- the seat's own lifecycle ---------- */
  function christenBeing() {
    if (!cfg.being_id) return;
    try {
      const who = identityFor({ platform: cfg.platform, id: cfg.being_id, display: cfg.being });
      if (who.handle !== cfg.being) rechristen(who.handle, cfg.being);
    } catch (e) {
      say(`could not christen the being's platform id: ${e.message}`);
    }
  }

  return {
    name: cfg.name,
    host,
    async start() {
      christenBeing();
      for (const room of cfg.rooms) {
        const known = roomsOpen(room.stream);
        if (known) trackRoom(known.id, room.stream);
      }
      await host.start();
    },
    stop() {
      clearInterval(timer);
      park.stop();
      turns.stopAll(); // never a typing loop outliving the room it served
      host.stop();
    },
    restart: () => host.restart(),
    /** keeper: open a channel on the server AND its room in the house */
    async openStream(stream, title = null) {
      const configured = cfg.rooms.find((r) => r.stream === stream);
      const id = await ensureLive(stream, {
        title: title ?? configured?.title ?? null,
        beings: configured?.beings ?? null,
      });
      if (!host.state.open.has(stream)) await host.openChannel(stream);
      return { id, stream };
    },
    snapshot() {
      // a learned sighting over the servers file's own fallback (precedence: serve-room-open.mjs).
      const learned = selfDisplayFor(cfg.platform, cfg.being);
      return {
        ...host.snapshot(),
        being: cfg.being,
        displayName: learned ?? cfg.display_name ?? null,
        displayNameSource: learned ? "platform" : cfg.display_name ? "config" : null,
        rooms: cfg.rooms.map((r) => {
          const known = roomsOpen(r.stream);
          return { ...r, run: known?.id ?? null, live: known?.live ?? false };
        }),
        tailing: [...tails.keys()],
        stats,
        inferenceRequests,
      };
    },
  };
}

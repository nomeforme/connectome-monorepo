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
import { applyCommandDispatchSettings } from "../commands/store.mjs";
import { identityFor, phoneId, rechristen } from "../identity-map.mjs";
import { roomPostureFor } from "../resident-covenant.mjs";
import { RUNS } from "../serve-paths.mjs";
import { addParticipant } from "../serve-rooms.mjs";
import { readCls } from "../room-policy.mjs";
import { streamRelay } from "../room-fork.mjs";
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
import { createLinkGate, matchLinkCommand } from "./link.mjs";
import { createRemoteHost } from "./remote-host.mjs";
import { storeInboundAttachments } from "./media-in.mjs";
import { createPark } from "./park.mjs";
import { frameSeqForMessageId } from "./message-index.mjs";
import { createReplyQueue, providerErrorNotice } from "./outbound.mjs";
import { createRedeliverWatcher } from "./redeliver.mjs";
import { createRelay, tooOldToRelay } from "./relay.mjs";
import { applyCommandAction, applyInputAction, applyMetaFrameAction, christenBeing as christenBeingWith, createRoomTails, isMetaFrameAction } from "./room-tails.mjs";
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
  // a server that announces its own account id on connect (the Discord pin's
  // "connected as bot <id>") christens it when the servers file left being_id unset
  const learnBeingId = (line) => {
    const m = !cfg.being_id && /connected as bot (\d{15,22})/.exec(String(line));
    if (m) {
      cfg.being_id = m[1];
      christenBeing();
      say("learned being_id from the server's own connect line");
    }
    log(line);
  };
  // harness-port W6, 2026-09-19: `hosted_by: "being"` (config.mjs) picks the
  // remote host (mcpl/remote-host.mjs) — same interface, wired to the
  // being's own socket instead of a spawned child; `hostOpts.createHost`
  // (tests only, today) always wins when given. Nothing below this line
  // changes: routing, apply, speak, typing, `!` commands all read `host`
  // through the one shared interface either factory returns.
  const { createHost: hostFactoryOverride, ...restHostOpts } = hostOpts;
  const hostFactory = hostFactoryOverride ?? (cfg.hosted_by === "being" ? createRemoteHost : createHost);
  const host = hostFactory({
    server: cfg,
    log: learnBeingId,
    onIncoming,
    onHistory: async (channelId, messages) => {
      for (const m of messages) learnSelfDisplay(m);
      await sweepHistory({ roomsOpen, apply, houseLine, say, RUNS, routeDeps }, channelId, messages);
    },
    onInferenceRequest: (params) => {
      inferenceRequests.push({ t: new Date().toISOString(), params });
      if (inferenceRequests.length > 20) inferenceRequests.shift();
    },
    ...restHostOpts,
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
  // no wake/sleep alarm clock in this port (module header) — every being
  // reads as awake; dispatch.mjs's own posture/dispatch gates still apply.
  const awakeOf = () => true;
  const isBeing = (handle) => !!testamentFor(handle);
  // a plain allowlist in place of the source's own keeper lookup (module header).
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
    // !rr/!bb (commands/store.mjs) overlay here — the one place a covenant
    // is read from, so a setting a keeper just ran hits the next decision.
    covenants: (h, k) => {
      const b = roomPostureFor(h, k);
      return { ...b, dispatch: applyCommandDispatchSettings(b.dispatch) };
    },
    roomKeyOf,
    awakeOf,
    isKeeper: (h) => keeperHandles().includes(h),
    frameSeqFor: (roomId, messageId) => frameSeqForMessageId(join(RUNS, roomId), messageId),
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
    // "any" (harness-port W5-A): axon parity answers an unlinked DM too
    // (signal-axon/src/grpc/components/signal-message-receptor.ts:448-455
    // — the fleet's Signal axon answered every DM, no linking concept at
    // all) — skip the pre-gate's own unlinked-DM auto-reply-and-block for
    // an ordinary message; `link <code>` itself still runs through it.
    const skipGate = cfg.rooms_policy === "any" && !matchLinkCommand(adapter.text(msg));
    const gate = skipGate ? null : linkGate.intercept(msg);
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
    // one line per message: who activated and why not — the seam every pilot reads
    if (input)
      say(`in ${input.by_kind}:${input.by} → ${input.targets?.length ? `activates ${input.targets.join(",")}` : "no activation"} ${JSON.stringify(input.reasons ?? {})}`);
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
      if (a.kind === "command") {
        // room-tails.mjs's own applyCommandAction: ensure, record
        // (observe-only), intent, reply — see its own header.
        const ctx = { messageId: msg.messageId, text: adapter.text(msg) };
        roomId = await applyCommandAction({ cfg, ensureLive, roomInput, speak, say, trackRoom, tails }, a, ctx);
        continue;
      }
      // a reaction/edit/delete meta-event, always an already-open room.
      if (isMetaFrameAction(a)) {
        applyMetaFrameAction({ RUNS }, a);
        roomId = a.roomId;
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
        // no sleeping-resident threshold ack in this port (module header)
        // — a documented no-op, since `awakeOf` always true means
        // route.mjs should never actually emit this action kind.
      } else if (a.kind === "input") {
        // room-tails.mjs's own applyInputAction: record, redirect to an
        // active fork if any (room-fork.mjs's activeFork, C13), relay
        // marks, pending-reply queue — see its own header.
        await applyInputAction(
          { cfg, roomInput, relay, turns, pendingReply, stats, streaks, linkGate, addParticipant },
          a,
          { msg, runDir, attachments, roomId },
        );
      }
    }
  }

  /* ---------- outbound: the room's record → the platform (speak.mjs) ---------- */

  function onFrame(roomId, stream, runDir, f, forkName = null) {
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
    // a fork's own speech carries no platform channel of its own (C13) —
    // rendered into the PARENT's `stream` instead, with the fleet's own
    // relay prefix (fork-replies.mjs's streamRelay, byte-exact source).
    const outText = forkName ? streamRelay.prefix(cfg.platform, forkName, cfg.being) + text : text;
    // typing until the words have landed on the platform, never past them
    void speak(roomId, stream, outText, { by: cfg.being, replyTo, seq: f.seq }).then(() =>
      turns.stopTyping(stream, "final speech"),
    );
  }

  function pollTails() {
    redeliver.check(tails);
    for (const [roomId, t] of tails) {
      const { frames, offset } = tailFrames(join(t.runDir, "frames.jsonl"), t.offset);
      t.offset = offset;
      for (const f of frames) onFrame(roomId, t.stream, t.runDir, f, t.forkName);
    }
  }
  const timer = setInterval(pollTails, POLL_MS);
  timer.unref();

  /* ---------- the seat's own lifecycle ---------- */
  function christenBeing() {
    christenBeingWith(cfg, identityFor, rechristen, say);
  }

  // harness-port W5-A, 2026-09-19: this seat's own Signal-style identity —
  // never the number itself, only its hash, and never logged.
  function deriveNumberId() {
    if (!cfg.number_env || cfg.number_id) return;
    const number = process.env[cfg.number_env];
    if (!number) {
      say(`number_env ${cfg.number_env} is unset — this seat's own identity will not be christened`);
      return;
    }
    cfg.number_id = phoneId(number);
    say(`derived this seat's own identity from ${cfg.number_env} (hashed, never logged)`);
  }

  return {
    name: cfg.name,
    host,
    async start() {
      deriveNumberId();
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
      const opts = { title: title ?? configured?.title ?? null, beings: configured?.beings ?? null };
      const id = await ensureLive(stream, opts);
      if (!host.state.open.has(stream)) await host.openChannel(stream);
      return { id, stream };
    },
    snapshot() {
      // a learned sighting over the servers file's own fallback (precedence: serve-room-open.mjs).
      const learned = selfDisplayFor(cfg.platform, cfg.being);
      return {
        ...host.snapshot(),
        being: cfg.being,
        observe_only: cfg.observe_only === true,
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

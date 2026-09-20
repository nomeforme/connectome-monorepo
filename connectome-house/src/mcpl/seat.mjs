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
import { applyCommandDispatchSettings, memoryGet } from "../commands/store.mjs";
import { displayFor, identityFor, phoneId, rechristen } from "../identity-map.mjs";
import { explicitRandomReply, roomPostureFor } from "../resident-covenant.mjs";
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
import { alreadyRelayedOut, claimRelay, createRelay, isRelayOwner, tooOldToRelay } from "./relay.mjs";
import { applyCommandAction, applyInputAction, applyMetaFrameAction, christenBeing as christenBeingWith, createRoomTails, createSelfTracker, isMetaFrameAction } from "./room-tails.mjs";
import { routeIncoming } from "./route.mjs";
import { noteSelfDisplay, selfDisplayFor } from "./self-display.mjs";
import { isOutboundOff, unmuteAll } from "./outbound-guard.mjs";
import { createSpeaker } from "./speak.mjs";
import { createFrameDelivery } from "./seat-bus.mjs";
import { sweepHistory } from "./sweep.mjs";
import { createTurns } from "./turns.mjs";

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
  // harness-port W6/28-reattach-gaps: `being_id` is permanently null for a
  // `hosted_by: "being"` seat (the child's own stderr connect line never
  // reaches the house) — its own account id instead arrives at `cfg.self_id`
  // (platform.hello.capabilities.self, room-tails.mjs's createSelfTracker),
  // the same fallback christenBeing itself already reads (room-tails.mjs
  // ~:377). Gating on `being_id` alone left `selfDisplayFor` permanently
  // null for every being-hosted seat, so a literal `@<display name>` mention
  // (rewriteSelfMention, adapters.mjs) was always a no-op there.
  function learnSelfDisplay(msg) {
    const selfId = cfg.being_id || cfg.self_id;
    if (selfId && msg?.author?.id === selfId)
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
    // rule 1 (outbound-guardrail, 2026-09-20): "typing" is one of the four
    // call kinds the kill switch must stop, same as a real send — turns.mjs
    // is NO-TOUCH for this task, so the gate sits in this thin wrapper
    // instead (only `typing`/`lifecycle` are ever read off `host` here,
    // per createTurns's own JSDoc). Turning typing OFF always passes
    // through — never leave a stuck "typing…" indicator behind a mute.
    host: { typing: (stream, on) => (on && isOutboundOff() ? undefined : host.typing(stream, on)), lifecycle: (p) => host.lifecycle(p) },
    roomIdOf: (stream) => roomsOpen(stream)?.id ?? null,
    say,
  });
  // `getAttachedAt` is a lazy lookup into `tails` (createRoomTails, below) —
  // safe even though `tails` isn't declared yet: the closure only reads it
  // once speak()/speakMedia() actually run, well after start().
  const { speak, speakMedia, houseLine } = createSpeaker({
    cfg,
    host,
    stats,
    say,
    RUNS,
    getAttachedAt: (roomId) => tails.get(roomId)?.attachedAt ?? 0,
  });
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
    // platform-reach's human-display round (docs/harness-port/37-human-
    // display.md): the real answer route.mjs's own `displayFor` dep was
    // left defaulted to a no-op for — wiring it here is what actually
    // makes another human's inbound `<@id>` mention render as their
    // current platform display, not their kept pseudonym, in the text a
    // being reads.
    displayFor,
    isBeing,
    // !rr/!bb (commands/store.mjs) overlay here — the one place a covenant
    // is read from, so a setting a keeper just ran hits the next decision.
    // random_reply precedence (harness-port W6-R3, K1 fix): the
    // testament's/room-override's own EXPLICIT value (explicitRandomReply,
    // never normalizeCovenant's 0 fallback) beats `!rr`, which beats
    // route.mjs's own platform default — when NEITHER names a number the
    // key is dropped entirely so that platform default can actually win
    // (`{...defaults, ...base.dispatch}` in route.mjs only works if a
    // silent covenant carries no key at all, not a defaulted 0).
    covenants: (h, k) => {
      const b = roomPostureFor(h, k);
      const dispatch = applyCommandDispatchSettings(b.dispatch);
      const explicit = explicitRandomReply(h, k);
      const rr = memoryGet(null, "dispatch.random_reply", undefined);
      if (explicit !== undefined) dispatch.random_reply = explicit;
      else if (rr === undefined) delete dispatch.random_reply;
      return { ...b, dispatch };
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
    // rule 5's own reset lever (docs/harness-port/25-outbound-guardrail.md):
    // recognized HERE, before any routing, the same way linkGate's own
    // `link <code>` is below — commands/registry.mjs's own table (NO-TOUCH
    // for this task) has no slot for a brand-new command name, and an
    // unrecognized `!x` falls through as an ordinary message on Discord/
    // web (commands/index.mjs), so a table entry wouldn't even fire
    // uniformly across platforms. Never recorded as a room turn, never
    // activates a being — a keeper-only, log-only acknowledgement.
    if (/^!unmute\b/i.test(String(adapter.text(msg) ?? "").trim())) {
      const senderId = msg?.author?.id;
      const sender = senderId
        ? identityFor({ platform: cfg.platform, id: senderId, display: msg?.author?.name ?? null }).handle
        : null;
      if (sender && keeperHandles().includes(sender)) {
        const cleared = unmuteAll();
        say(`!unmute from @${sender}: ${cleared} tripped outbound breaker(s) reset`);
      } else {
        say(`!unmute from a non-keeper (${sender ?? "unknown sender"}) — ignored`);
      }
      return Promise.resolve({ accepted: false, reason: "unmute" });
    }
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
    // bookkeeping only (turns.mjs's own `mint`) — the platform's immediate
    // ack below still carries an inferenceId; typing itself no longer
    // starts here (harness-port 34, docs/harness-port/
    // 34-typing-after-decision.md): every present seat computes its OWN
    // activation guess independently (dispatch.mjs's `random_reply` is a
    // real per-seat `Math.random()`), so starting typing off THIS seat's
    // own guess — before the room's own recorded decision is even known —
    // is exactly the race 31-silent-turn.md diagnosed. `turns.activate`
    // (room-tails.mjs's own applyInputAction, below apply()) is now the
    // ONLY place typing actually switches on, gated on the ROOM's own
    // recorded targets, not this seat's own.
    for (const being of input?.targets ?? []) inferenceId = turns.mint(stream, being);
    chain = chain
      .then(() => park.guarded(msg, actions, stream))
      .then(() => {
        // structural guard (docs/harness-port/31-silent-turn.md), kept as
        // a backstop now that typing itself only ever starts off the
        // ROOM's own recorded decision (applyInputAction's `turns.
        // activate`, above): this still catches a real activation whose
        // own `beginTurn` (room-turn.mjs) never actually marked the
        // room's own `rec.turns` for it. A REAL `beginTurn` marks that
        // synchronously, well before generation completes, so "no
        // in-flight turn once apply() has settled" is never a false
        // positive against a merely slow turn — only one that was never
        // truly delivered at all.
        if (!(stream && turns.typing(stream))) return;
        try {
          const roomId = roomsOpen(stream)?.id ?? null;
          if (roomId && open.get(roomId)?.turns?.get(cfg.being)) return; // a real turn IS in flight — no-op
          say(`turn stalled → ${stream} (@${cfg.being} activated, no in-flight turn once apply() settled — releasing)`);
          turns.end(stream, cfg.being, "stalled");
          turns.stopTyping(stream, "stalled: activated with no delivered turn.begin");
        } catch (e) {
          say(`turn-stall guard itself failed for ${stream}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
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
        const deps = { cfg, ensureLive, roomInput, speak, say, trackRoom, tails, drainOne: frameDelivery.drainOne };
        roomId = await applyCommandAction(deps, a, ctx);
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

  function onFrame(roomId, stream, runDir, f, forkName = null, attachedAt = 0) {
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
      if (tooOldToRelay(f, attachedAt)) {
        houseLine(
          roomId,
          "[an app line from before this seat's catch-up window arrived too late to relay]",
        );
        return;
      }
      // 2026-09-20 incident (docs/harness-port/24-incident-…md §2/§5,
      // guardrail #4): unlike speech/media.attached, a `message` frame had
      // NO per-seat ownership rule at all — every present seat relayed
      // every such line independently (21-fold in the incident). Only the
      // room's own roster-order "owner" seat ever attempts it, and even
      // that seat checks the room-shared ledger first (relay.mjs's own
      // header explains both).
      if (!isRelayOwner(roomsOpen(stream)?.beings, cfg.being)) return;
      if (alreadyRelayedOut(runDir, f.seq)) return;
      const text = relay.textFor(roomId, runDir, f);
      if (!text) return;
      // the atomic claim (relay.mjs's own header, docs/harness-port/
      // 25-outbound-guardrail.md's retro-stamp section): the two checks
      // above are read-then-decide and can't by themselves stop two
      // concurrent callers (two processes for this being, or a redeliver
      // path racing the live tail) from both reaching this point before
      // either has actually sent — `claimRelay` is the one atomic
      // filesystem operation that decides, of any number of racing
      // callers, exactly one. Claimed BEFORE the platform call
      // (`speak()`, right below); a lost claim means someone else already
      // owns this seq's relay — skip silently, same shape as the checks
      // above.
      if (!claimRelay(runDir, f.seq)) return;
      void speak(roomId, stream, text, { by: f.by, seq: f.seq, frame: f });
      return;
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
    void speak(roomId, stream, outText, { by: cfg.being, replyTo, seq: f.seq, frame: f }).then(() =>
      turns.stopTyping(stream, "final speech"),
    );
  }

  // harness-port W7-b: the bus (seat-bus.mjs) delivers instantly now;
  // `checkSelf` (defined below) is only ever read once its own tick fires.
  const frameDelivery = createFrameDelivery({
    tails,
    tailFrames,
    onFrame,
    checkSelf: () => checkSelf(),
    redeliverCheck: (t) => redeliver.check(t),
  });

  /* ---------- the seat's own lifecycle ---------- */
  function christenBeing() {
    christenBeingWith(cfg, identityFor, rechristen, say);
  }

  // harness-port W6-R1 (self.uuid) / W6-R5 (self.id, Discord's being-
  // hosted shape — no `being_id` of its own), 2026-09-19: room-tails.mjs's
  // own `createSelfTracker` polls `host.state.self` and re-christens the
  // moment ANY of its fields is new (extracted there, not here, to keep
  // this file under its own line-length ratchet).
  const checkSelf = createSelfTracker({ cfg, host, identityFor, rechristen, say });

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
      frameDelivery.startupSweep(); // anything appended before this seat ever tracked the room
    },
    stop() {
      frameDelivery.stop();
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

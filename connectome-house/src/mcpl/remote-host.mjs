// @ts-check
/* connectome-house/src/mcpl/remote-host.mjs — createHost's own interface
 * (mcpl/host.mjs), wired to a being-hosted MCPL child instead of a
 * house-spawned one (harness-port W6, 2026-09-19: "each being's
 * container hosts its own platform children"). No stdio, no spawn: every
 * host.mjs verb becomes a `platform.*` wire message (connectome-seat-
 * protocol's own schema, connectome-seat-protocol/src/messages.mjs) sent
 * over the ONE socket connection a being already holds for its own turns
 * (seat/socket-seat.mjs's `remoteHostsByBeing` registry finds THIS
 * instance by (being, server) when a `platform.*` message arrives — see
 * that module's own header). This file never opens a socket itself: the
 * house's one seat server (already listening for turn traffic) hands
 * this host every message addressed to its own `server.name`, and a
 * `send` function to answer with through `receive(msg, send)` — the ONE
 * ingress a being's connection drives this host through, never part of
 * createHost's own consumer-facing interface (seat.mjs/speak.mjs/
 * turns.mjs/link.mjs/being-tools.mjs never call it directly).
 *
 * Grant enforcement is NOT duplicated here: the being's own child-side
 * host (mirroring host.mjs, W6-B's mcpl/child.mjs) already negotiated ITS
 * grant with the real MCPL server before ever reporting a tools list in
 * `platform.hello` — this proxy trusts that list (`st.grant = ["tools"]`
 * once hello lands) and only re-applies calls.mjs's own `callRefusal` for
 * the SAME typed refusal shape every caller already catches
 * (`GrantRefused`), never a second capability negotiation.
 *
 * Named interface gaps from createHost (this task's own report has the
 * full account): `toolDefs` stays `[]` (the wire carries tool NAMES
 * only — messages.mjs's own comment on `platform.hello`); `closeChannel`
 * has no wire counterpart (nothing calls it today, house-wide — grep) and
 * is house-side bookkeeping only; `platform.history` (being → house) is
 * handled independently of `openChannel`'s own returned promise rather
 * than awaited inline, so an `await openChannel()` may settle before
 * `onHistory` runs — the one call site today (seat.mjs's `openStream`)
 * never reads history from that return value either way. */
import { randomUUID } from "node:crypto";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";
import { adapterFor } from "./adapters.mjs";
import { GrantRefused, callRefusal, seenWindow } from "./calls.mjs";
import { METHOD } from "./wire.mjs";

const COUNTERS = "incoming pushed deduped toolCalls refused restarts rejected inferenceRequests";

/**
 * @param {{
 *   server: {name: string, platform: string, rooms?: {stream: string, title?: string|null}[],
 *     rooms_policy?: "listed"|"any"},
 *   onIncoming: (msg: import("./normalize.mjs").IncomingMessage) => Promise<{accepted: boolean,
 *     inferenceId?: string|null, conversationId?: string|null, reason?: string}>,
 *   onHistory?: (channelId: string, messages: import("./normalize.mjs").IncomingMessage[]) => Promise<void>|void,
 *   onInferenceRequest?: (params: unknown) => void,
 *   log?: (line: string) => void,
 *   requestTimeoutMs?: number,
 *   historyLimit?: number,
 * }} opts */
export function createRemoteHost({
  server,
  onIncoming,
  onHistory,
  onInferenceRequest,
  log = () => {},
  requestTimeoutMs = 15_000,
  historyLimit = 50,
}) {
  const st = {
    name: server.name,
    platform: server.platform,
    /** @type {"waiting"|"starting"|"ready"|"degraded"|"mcp-only"|"stopped"|"crashed"}
     * "waiting" is this host's own addition (createHost never has it): no
     * being has ever said hello, or the last one detached — excluded from
     * calls.mjs's CALLABLE_STATES, so a call attempted before/between
     * attachments refuses "not-ready" through the very same gate a
     * spawned host uses, no special-casing needed at the call site. */
    state: "waiting",
    manifest: /** @type {any} */ (null),
    revision: /** @type {string|null} */ (null),
    // the being's own child (mcpl/child.mjs) forwards its server's
    // announced identity here inside `platform.hello.capabilities.self`
    // (harness-port W6-R1) — absent until that child's own handshake
    // learned it.
    self: /** @type {{uuid: string, numberId: string}|null} */ (null),
    grant: /** @type {string[]} */ ([]),
    receipt: /** @type {any} */ (null),
    tools: /** @type {string[]} */ ([]),
    toolDefs: /** @type {{name: string, description?: string, inputSchema?: object}[]} */ ([]),
    channels: /** @type {Map<string, any>} */ (new Map()),
    open: /** @type {Map<string, {history: import("./normalize.mjs").IncomingMessage[]}>} */ (new Map()),
    lastError: /** @type {string|null} */ (null),
    counts: Object.fromEntries(COUNTERS.split(" ").map((k) => [k, 0])),
    startedAt: /** @type {string|null} */ (null),
  };
  const say = (line) => log(`[mcpl:${server.name}] ${line}`);
  const remember = seenWindow();
  const opening = new Set();
  /** @type {((msg: Record<string, unknown>) => boolean)|null} the attached
   * being's own seat.send — null whenever no being is currently connected
   * for this server (never attached yet, or detached since). */
  let wireSend = null;
  /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();

  /** @param {Record<string, unknown>} msg */
  function send(msg) {
    return wireSend?.({ room: PLATFORM_ROOM, server: server.name, ...msg }) ?? false;
  }

  /** house → being, answered by a matching `platform.result` — both
   * `platform.call` and `platform.open` share this one id-keyed map (the
   * wire's own single result type for either request, messages.mjs).
   * @param {string} type @param {Record<string, unknown>} extra */
  function request(type, extra) {
    if (!wireSend)
      return Promise.reject(new Error(`${server.name}: no being is currently connected`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} to ${server.name} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      send({ type, id, ...extra });
    });
  }

  /** mirrors host.mjs's own `deliver` (dedupe window, typed rejection on
   * a throwing handler) — kept identical in shape so seat.mjs's onIncoming
   * callback sees no difference between a spawned and a remote host. */
  async function deliver(msg) {
    if (!remember(msg?.eventId)) {
      st.counts.deduped += 1;
      return { accepted: true, reason: "duplicate" };
    }
    try {
      const r = await onIncoming(msg);
      if (!r?.accepted) st.counts.rejected += 1;
      return r ?? { accepted: false, reason: "no answer" };
    } catch (e) {
      st.lastError = e.message;
      say(`incoming handler failed: ${e.message}`);
      return { accepted: false, reason: e.message };
    }
  }

  function setChannels(list) {
    for (const c of Array.isArray(list) ? list : [])
      if (c && typeof c.id === "string") st.channels.set(c.id, c);
  }

  async function openChannel(channelId, { history = historyLimit } = {}) {
    const r = /** @type {any} */ (
      await request("platform.open", {
        channelId,
        ...(history > 0 ? { history: { limit: history } } : {}),
      })
    );
    // history itself, if any, arrives independently via `platform.history`
    // (this file's own header) — mark the channel open now regardless.
    if (!st.open.has(channelId)) st.open.set(channelId, { history: [] });
    if (r?.channel?.id) st.channels.set(r.channel.id, r.channel);
    return r;
  }

  /** mirrors host.mjs's own `openStandingRooms` (same skip conditions, same
   * "any" rooms_policy fan-out) — a fresh `platform.hello`/`platform.channels`
   * re-runs this, but an already-open stream (`st.open.has`) is always
   * skipped, so a reconnect never re-opens what's already open. */
  async function openStandingRooms() {
    const streams = new Set((server.rooms ?? []).map((r) => r.stream));
    if (server.rooms_policy === "any") for (const id of st.channels.keys()) streams.add(id);
    for (const stream of streams) {
      if (st.open.has(stream) || opening.has(stream) || !st.channels.has(stream)) continue;
      opening.add(stream);
      try {
        await openChannel(stream);
        say(`opened ${stream}`);
      } catch (e) {
        st.lastError = e.message;
        say(`could not open ${stream}: ${e.message}`);
      } finally {
        opening.delete(stream);
      }
    }
  }

  /** the ONLY ingress a being's connection drives this host through
   * (seat/socket-seat.mjs's platform.* dispatch) — every message this
   * server's being ever sends lands here, `sendFn` re-armed on each call
   * so a reconnect's first message (always `platform.hello`) restores
   * outbound delivery before anything else runs.
   * @param {Record<string, any>} msg @param {(m: Record<string, unknown>) => boolean} sendFn */
  function receive(msg, sendFn) {
    wireSend = sendFn;
    switch (msg.type) {
      case "platform.hello":
        st.tools = Array.isArray(msg.tools) ? msg.tools : [];
        setChannels(msg.channels);
        st.self = msg.capabilities?.self ?? st.self;
        // this proxy trusts the being's own negotiated grant (file header)
        st.grant = ["tools"];
        st.state = "ready";
        st.startedAt ??= new Date().toISOString();
        say(`hello from @${msg.being} — ${st.tools.length} tool(s), ${st.channels.size} channel(s)`);
        void openStandingRooms();
        break;
      case "platform.incoming":
        st.counts.incoming += 1;
        void deliver(/** @type {any} */ (msg.msg));
        break;
      case "platform.history":
        if (typeof msg.channelId === "string") {
          const hist = /** @type {any} */ (Array.isArray(msg.messages) ? msg.messages : []);
          st.open.set(msg.channelId, { history: hist });
          void onHistory?.(msg.channelId, hist);
        }
        break;
      case "platform.channels":
        setChannels(msg.channels);
        void openStandingRooms();
        break;
      case "platform.result": {
        const p = pending.get(/** @type {string} */ (msg.id));
        if (!p) break;
        pending.delete(/** @type {string} */ (msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(typeof msg.error === "string" ? msg.error : "platform call refused"));
        break;
      }
      case "platform.child":
        if (msg.state === "ready") st.state = "ready";
        else if (msg.state === "starting") st.state = "starting";
        else if (msg.state === "exited") st.state = "stopped";
        else if (msg.state === "failed") {
          st.state = "crashed";
          st.counts.restarts += 1;
        }
        if (typeof msg.detail === "string") st.lastError = msg.detail;
        say(`child ${msg.state}${msg.detail ? `: ${msg.detail}` : ""}`);
        break;
      default:
        break; // an unrecognized platform.* type is ignored — additive wire, never a throw
    }
  }

  /** the being's connection dropped (seat/socket-seat.mjs's onExit) —
   * `state` is deliberately left as-is (kept for the snapshot, this
   * file's own mission); only reachability (`connected()`) and in-flight
   * calls change. */
  function wireDetached() {
    wireSend = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${server.name}: the being's seat detached`));
    }
    pending.clear();
  }

  return {
    state: st,
    /** no child to spawn: resolves at once, "waiting" until a
     * `platform.hello` lands (already "ready" here if one arrived before
     * this call — a seat restart racing a being already connected). */
    start() {
      return Promise.resolve();
    },
    stop() {
      st.state = "stopped";
    },
    /** no local process to kill — best-effort: re-open whatever
     * `openStandingRooms` still finds missing (a channel the being's own
     * child re-registered underneath a stale `st.open` would otherwise
     * never be retried). No dedicated "restart the being's child" wire
     * verb exists (a named gap — this task's report). */
    restart() {
      return openStandingRooms();
    },
    openChannel,
    /** no wire counterpart (messages.mjs's platform.* set has no
     * "close") — house-side bookkeeping only; nothing calls this today
     * anywhere in this package (grep, this task's report). */
    async closeChannel(channelId) {
      st.open.delete(channelId);
    },
    /** the grant gates every call (calls.mjs), same as a spawned host —
     * a refusal is typed and counted, never sent. */
    async callTool(name, args) {
      const refusal = callRefusal(st, name);
      if (refusal) {
        st.counts.refused += 1;
        throw new GrantRefused(refusal);
      }
      st.counts.toolCalls += 1;
      return request("platform.call", { name, args });
    },
    typing: (channelId, on = true) => {
      const t = adapterFor(server.platform).typing(channelId, on);
      send({ type: "platform.notify", method: t.method, params: t.params });
    },
    lifecycle: (p) => send({ type: "platform.notify", method: METHOD.INFERENCE_LIFECYCLE, params: p }),
    connected: () => !!wireSend,
    /** seat/socket-seat.mjs's own ingress/egress hooks — not part of
     * createHost's consumer-facing interface (this file's own header). */
    receive,
    wireDetached,
    snapshot() {
      return {
        name: st.name,
        platform: st.platform,
        state: st.state,
        revision: st.revision,
        self: st.self,
        grant: st.grant,
        receipt: st.receipt,
        tools: st.tools,
        toolDefs: st.toolDefs,
        channels: [...st.channels.keys()],
        open: [...st.open.keys()],
        rooms: (server.rooms ?? []).map((r) => ({ stream: r.stream, title: r.title ?? null })),
        lastError: st.lastError,
        counts: { ...st.counts },
        startedAt: st.startedAt,
        attached: !!wireSend,
      };
    },
  };
}

// @ts-check
/* harness/src/mcpl/host.mjs — the host LOOP for one MCPL server, the
 * study's §1.9 minimal host, written to the spec and the house's mock,
 * never to one server's quirks: initialize → notifications/initialized →
 * featureSets/update AS A REQUEST with the grant (sent at once, inside any
 * server's policy grace; the receipt kept, never widened on) → tools/list
 * → every server→host Request answered (both envelopes → one normalized
 * message, deduped by id; unsupported → error) → channels/open per
 * configured standing room once registered, history kept structured →
 * backoff restart on child exit (re-handshake, re-open; a changed
 * manifest digest is logged, not refused — RFC-003). Rooms, beings,
 * identities, covenants are route.mjs's and seat.mjs's, not this file's:
 * it hands over a message and asks "accepted?". */
import { METHOD, RPC, manifestRevision, rpcError, spawnWire } from "./wire.mjs";
import { adapterFor } from "./adapters.mjs";
import { GrantRefused, callRefusal, seenWindow } from "./calls.mjs";
import { HOST_MCPL, computeGrant } from "./grant.mjs";
import { normalizeIncoming, normalizePush } from "./normalize.mjs";

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

const COUNTERS = "incoming pushed deduped toolCalls refused restarts rejected inferenceRequests";

/**
 * @param {{
 *   server: {name: string, platform: string, command: string, args?: string[], env?: string[],
 *     cwd?: string, rooms?: {stream: string, title?: string|null}[],
 *     rooms_policy?: "listed"|"any"},
 *   onIncoming: (msg: IncomingMessage) => Promise<{accepted: boolean, inferenceId?: string|null,
 *     conversationId?: string|null, reason?: string}>,
 *   onInferenceRequest?: (params: unknown) => void,
 *   onHistory?: (channelId: string, messages: IncomingMessage[]) => Promise<void>|void,
 *   log?: (line: string) => void,
 *   spawn?: typeof spawnWire,
 *   backoffMs?: {min: number, max: number},
 *   requestTimeoutMs?: number,
 *   historyLimit?: number,
 *   hostVersion?: string,
 * }} opts */
export function createHost({
  server,
  onIncoming,
  onInferenceRequest,
  onHistory,
  log = () => {},
  spawn = spawnWire,
  backoffMs = { min: 1000, max: 60_000 },
  requestTimeoutMs = 15_000,
  historyLimit = 50,
  hostVersion = "0",
}) {
  const st = {
    name: server.name,
    platform: server.platform,
    /** @type {"idle"|"starting"|"ready"|"degraded"|"mcp-only"|"stopped"|"crashed"} */
    state: "idle",
    manifest: /** @type {any} */ (null),
    revision: /** @type {string|null} */ (null),
    // this server's own announced identity (harness-port W6-R1): the
    // uuid/numberId shape mcpl-signal's initialize/`channels/self` carry —
    // never authorization, informational, absent until a server says so.
    self: /** @type {{uuid: string, numberId: string}|null} */ (null),
    grant: /** @type {string[]} */ ([]),
    receipt: /** @type {any} */ (null),
    tools: /** @type {string[]} */ ([]),
    // FULL tools/list entries, not just names (`tools` stays name-only —
    // every existing caller keeps reading it unchanged).
    toolDefs: /** @type {{name: string, description?: string, inputSchema?: object}[]} */ ([]),
    channels: /** @type {Map<string, any>} */ (new Map()),
    open: /** @type {Map<string, {history: IncomingMessage[]}>} */ (new Map()),
    lastError: /** @type {string|null} */ (null),
    counts: Object.fromEntries(COUNTERS.split(" ").map((k) => [k, 0])),
    startedAt: /** @type {string|null} */ (null),
  };
  /** @type {import("./wire.mjs").Wire|null} */
  let wire = null;
  let stopped = false;
  let backoff = backoffMs.min;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let restartTimer = null;
  const remember = seenWindow();
  const say = (line) => log(`[mcpl:${server.name}] ${line}`);

  async function deliver(msg) {
    if (!remember(msg.eventId)) {
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

  async function handleRequest(method, params) {
    switch (method) {
      case METHOD.PUSH_EVENT: {
        st.counts.pushed += 1;
        const r = await deliver(normalizePush(params));
        return r.accepted
          ? { accepted: true, ...(r.inferenceId ? { inferenceId: r.inferenceId } : {}) }
          : { accepted: false, reason: r.reason ?? "not accepted" };
      }
      case METHOD.CHANNELS_INCOMING: {
        const messages = Array.isArray(params?.messages) ? params.messages : [];
        const results = [];
        for (const m of messages) {
          st.counts.incoming += 1;
          const norm = normalizeIncoming(m);
          if (norm.channelId && !st.channels.has(norm.channelId))
            say(`incoming on an unregistered channel ${norm.channelId} (accepted by house rule)`);
          const r = await deliver(norm);
          results.push({
            messageId: norm.messageId,
            accepted: !!r.accepted,
            ...(r.conversationId ? { conversationId: r.conversationId } : {}),
            ...(r.accepted ? {} : { reason: r.reason ?? "not accepted" }),
          });
        }
        return { results };
      }
      case METHOD.CHANNELS_REGISTER:
      case METHOD.CHANNELS_CHANGED: {
        const added = [
          ...(Array.isArray(params?.channels) ? params.channels : []),
          ...(Array.isArray(params?.added) ? params.added : []),
          ...(Array.isArray(params?.updated) ? params.updated : []),
        ];
        const results = [];
        for (const d of added) {
          if (!d || typeof d.id !== "string") {
            results.push({ id: d?.id ?? null, accepted: false, reason: "no id" });
            continue;
          }
          st.channels.set(d.id, d);
          results.push({ id: d.id, accepted: true });
        }
        for (const id of Array.isArray(params?.removed) ? params.removed : []) {
          st.channels.delete(id);
          st.open.delete(id);
        }
        void openStandingRooms();
        return { results };
      }
      case METHOD.INFERENCE_REQUEST:
        // recorded as a house event, never run: the spec wants an error
        // over silence or a fabricated completion (§6.6, §11)
        st.counts.inferenceRequests += 1;
        say(`inference/request from feature set ${params?.featureSet ?? "?"} — recorded, not run`);
        onInferenceRequest?.(params);
        return rpcError(
          RPC.METHOD_NOT_FOUND,
          "inference/request is recorded as a house event; this host runs no inference on request",
        );
      case METHOD.CONTEXT_BEFORE_INFERENCE:
        return { contextInjections: [] };
      case METHOD.MCPL_MANIFEST_CHANGED:
        return {};
      default:
        return rpcError(RPC.METHOD_NOT_FOUND, `${method} is not supported by this host`);
    }
  }

  function handleNotification(method, params) {
    if (method === METHOD.MCPL_MANIFEST_CHANGED) {
      say(`manifest changed (revision ${params?.revision ?? "?"}) — noted; the grant is unchanged`);
      return;
    }
    // a server whose own uuid was still unknown at `initialize` (mcpl-
    // signal/src/self-identity.mjs's race note) announces it this way
    // once learned — informational, never re-negotiated as a grant.
    if (method === "channels/self") {
      st.self = params?.self ?? st.self;
      return;
    }
    if (method === METHOD.CHANNELS_CHANGED) void handleRequest(method, params);
  }

  async function openChannel(channelId, { history = historyLimit } = {}) {
    if (!wire || wire.isClosed()) throw new Error("not connected");
    const r = /** @type {any} */ (
      await wire.request(METHOD.CHANNELS_OPEN, {
        channelId,
        type: server.platform,
        ...(history > 0 ? { history: { limit: history } } : {}),
      })
    );
    const hist = adapterFor(server.platform).historyToKept(r?.history);
    st.open.set(channelId, { history: hist });
    if (r?.channel?.id) st.channels.set(r.channel.id, r.channel);
    if (hist.length && onHistory) await onHistory(channelId, hist);
    return r;
  }

  // register and the handshake both call this; one open per stream
  const opening = new Set();
  // "any" (harness-port W5-A): every stream the server has registered is
  // a standing room too, not only the configured ones — axon parity.
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

  async function handshake() {
    if (!wire) return;
    const init = /** @type {any} */ (
      await wire.request(METHOD.INITIALIZE, {
        protocolVersion: "2024-11-05",
        capabilities: { experimental: { mcpl: HOST_MCPL } },
        clientInfo: { name: "connectome-house", version: hostVersion },
      })
    );
    const caps = init?.capabilities ?? {};
    const manifest = caps?.experimental?.mcpl ?? null;
    const revision = manifest ? manifestRevision(manifest) : null;
    if (st.revision && revision !== st.revision)
      say(
        `manifest digest changed on reconnect: ${st.revision} → ${revision} (logged, not refused)`,
      );
    st.manifest = manifest;
    st.revision = revision;
    // a reconnect that lost the announcement keeps whatever was last known
    // rather than forgetting it (init?.serverInfo?.self absent ≠ retracted).
    st.self = init?.serverInfo?.self ?? st.self;
    wire.notify("notifications/initialized");
    if (!manifest) {
      st.state = "mcp-only";
      say("server advertises no experimental.mcpl — plain MCP only");
      return;
    }
    st.grant = computeGrant(caps);
    const receipt = /** @type {any} */ (
      await wire.request(METHOD.FEATURE_SETS_UPDATE, { effectiveCapabilities: st.grant })
    );
    st.receipt = receipt;
    if (receipt?.accepted === false) {
      st.state = receipt.fallback === "close" ? "stopped" : "mcp-only";
      say(`grant refused (${receipt.fallback ?? "?"}): ${receipt.reason ?? ""} — never widened`);
      if (receipt.fallback === "close") {
        // the server named its own consequence; a keeper restart is the
        // only way back, never an automatic retry loop
        stopped = true;
        wire.close();
      }
      return;
    }
    st.state = receipt?.mode === "degraded" ? "degraded" : "ready";
    for (const u of Array.isArray(receipt?.unavailableFeatures) ? receipt.unavailableFeatures : [])
      say(
        `degraded: ${u.featureSet} missing ${(u.missingCapabilities ?? []).join(",")} → ${u.effect}`,
      );
    try {
      const tl = /** @type {any} */ (await wire.request("tools/list", {}));
      st.toolDefs = Array.isArray(tl?.tools) ? tl.tools.filter((t) => t?.name) : [];
      st.tools = st.toolDefs.map((t) => t.name);
    } catch (e) {
      say(`tools/list failed: ${e.message}`);
    }
    await openStandingRooms();
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMs.max);
    say(`restarting in ${wait}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      st.counts.restarts += 1;
      void connect();
    }, wait);
    restartTimer.unref?.();
  }

  async function connect() {
    if (stopped) return;
    st.state = "starting";
    st.open.clear();
    st.channels.clear();
    opening.clear();
    try {
      wire = spawn({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
        requestTimeoutMs,
        log: say,
      });
    } catch (e) {
      st.state = "crashed";
      st.lastError = e.message;
      say(`spawn failed: ${e.message}`);
      scheduleRestart();
      return;
    }
    const w = wire;
    w.onRequest(handleRequest);
    w.onNotification(handleNotification);
    w.onClose(({ code, signal }) => {
      if (wire !== w) return;
      wire = null;
      if (stopped) {
        st.state = "stopped";
        return;
      }
      st.state = "crashed";
      st.lastError = `child exited (code ${code}, signal ${signal})`;
      say(st.lastError);
      scheduleRestart();
    });
    st.startedAt = new Date().toISOString();
    try {
      await handshake();
      if (st.state === "ready" || st.state === "degraded") backoff = backoffMs.min;
    } catch (e) {
      st.lastError = `handshake failed: ${e.message}`;
      say(st.lastError);
      w.close();
    }
  }

  /** a notification rides only when its capability is in the grant */
  function notifyIfGranted(cap, method, params) {
    if (wire && !wire.isClosed() && st.grant.includes(cap)) wire.notify(method, params);
  }

  return {
    state: st,
    start() {
      stopped = false;
      return connect();
    },
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      if (wire) {
        wire.notify("shutdown");
        wire.close();
      }
      st.state = "stopped";
    },
    restart() {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      backoff = backoffMs.min;
      const w = wire;
      wire = null;
      w?.close();
      return connect();
    },
    openChannel,
    async closeChannel(channelId) {
      if (!wire || wire.isClosed()) throw new Error("not connected");
      const r = await wire.request(METHOD.CHANNELS_CLOSE, { channelId });
      st.open.delete(channelId);
      return r;
    },
    /** the grant gates every call (calls.mjs): a refusal is typed and counted, never sent */
    async callTool(name, args) {
      const refusal = callRefusal(st, name);
      if (refusal) {
        st.counts.refused += 1;
        throw new GrantRefused(refusal);
      }
      if (!wire || wire.isClosed()) throw new Error("not connected");
      st.counts.toolCalls += 1;
      return wire.request("tools/call", { name, arguments: args });
    },
    /** on=true starts (re-sent as long as a turn runs), on=false stops —
     * the wire shape is the adapter's (adapters.mjs's `typing`), never
     * hardcoded to one platform here. */
    typing: (channelId, on = true) => {
      const t = adapterFor(server.platform).typing(channelId, on);
      notifyIfGranted(t.capability, t.method, t.params);
    },
    lifecycle: (p) => notifyIfGranted("inferenceLifecycle", METHOD.INFERENCE_LIFECYCLE, p),
    connected: () => !!wire && !wire.isClosed(),
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
      };
    },
  };
}

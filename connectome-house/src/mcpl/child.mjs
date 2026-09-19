// @ts-check
/* connectome-house/src/mcpl/child.mjs — the CHILD-SPAWNING half of
 * mcpl/host.mjs, ported for a being-hosted seat (harness-port W6-B,
 * 2026-09-19): "each being's container hosts its own platform children"
 * (its Discord token, its Signal number) instead of the house spawning
 * every bot itself. Ported BY COPY, not by editing host.mjs (W5-A/W6-A
 * own that file, and the house-hosted path stays exactly as it is): the
 * JSON-RPC handshake (initialize → notifications/initialized →
 * featureSets/update → tools/list), state (tools/channels/grant),
 * callTool/notify/openChannel, backoff restart on exit — all reused from
 * host.mjs's own shape. `platform-runner.mjs` is what actually decides
 * whether a message is accepted; a later cleanup should fold this and
 * host.mjs's loop into one shared module.
 *
 * What's cut from host.mjs's own createHost: the house's own accept/
 * reject BUSINESS decision. This process is not the house any more — the
 * house is one seat-socket hop away, and MCPL's own 30s request timeout
 * means the wire can't wait for that hop's answer before replying to the
 * child. So every push/event and channels/incoming is answered {accepted:
 * true} at once (§6.6: never leave an id unanswered) and the NORMALIZED
 * message is handed to `onIncoming` for platform-runner.mjs to forward as
 * a `platform.incoming` — the house's own routing/dedupe/apply decision
 * happens there now, asynchronously, same as every other turn. */
import { METHOD, RPC, manifestRevision, rpcError, spawnWire } from "./wire.mjs";
import { adapterFor } from "./adapters.mjs";
import { GrantRefused, callRefusal, seenWindow } from "./calls.mjs";
import { HOST_MCPL, computeGrant } from "./grant.mjs";
import { normalizeIncoming, normalizePush } from "./normalize.mjs";

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */
/** method -> grant capability, for the generic `notify()` passthrough
 * below (`platform.notify`, house -> being) — only the two methods
 * host.mjs itself ever gates are known; anything else is sent ungated
 * (logged), since the wire carries no capability name of its own. */
const CAPABILITY_FOR_METHOD = {
  [METHOD.CHANNELS_TYPING]: "channels.typing",
  [METHOD.INFERENCE_LIFECYCLE]: "inferenceLifecycle",
};

/**
 * @param {{name: string, platform: string, command: string, args?: string[],
 *   env?: string[], cwd?: string}} server only the spawn-shaped fields are
 *   read (`rooms`/`rooms_policy`/`box`/etc are the house's own routing
 *   concerns — the being never expands rooms, platform-runner.mjs's own
 *   header).
 * @param {{
 *   log?: (line: string) => void,
 *   onIncoming?: (msg: IncomingMessage) => void,
 *   onHistory?: (channelId: string, messages: IncomingMessage[]) => void,
 *   onChannels?: (channels: object[]) => void,
 *   onNotification?: (method: string, params: unknown) => void,
 *   onExit?: (info: {code: number|null, signal: string|null, everReady: boolean}) => void,
 *   onReady?: (snapshot: ReturnType<typeof snapshotOf>) => void,
 *   spawn?: typeof spawnWire,
 *   backoffMs?: {min: number, max: number},
 *   requestTimeoutMs?: number,
 *   historyLimit?: number,
 *   hostVersion?: string,
 * }} [opts] `onReady` is ADDITIVE to the six the mission named: fired once
 *   per successful handshake (first start AND every restart) — the exact
 *   moment platform-runner.mjs needs to (re-)send `platform.hello`; the
 *   six named hooks alone can't tell a restart's handshake apart from its
 *   exit.
 */
export function spawnChild(
  server,
  {
    log = () => {},
    onIncoming = () => {},
    onHistory = () => {},
    onChannels = () => {},
    onNotification = () => {},
    onExit = () => {},
    onReady = () => {},
    spawn = spawnWire,
    backoffMs = { min: 1000, max: 60_000 },
    requestTimeoutMs = 15_000,
    historyLimit = 50,
    hostVersion = "0",
  } = {},
) {
  const st = {
    name: server.name,
    platform: server.platform,
    /** @type {"idle"|"starting"|"ready"|"degraded"|"mcp-only"|"stopped"|"crashed"} */
    state: "idle",
    revision: /** @type {string|null} */ (null),
    grant: /** @type {string[]} */ ([]),
    tools: /** @type {string[]} */ ([]),
    toolDefs: /** @type {{name: string, description?: string, inputSchema?: object}[]} */ ([]),
    channels: /** @type {Map<string, any>} */ (new Map()),
    open: /** @type {Map<string, {history: IncomingMessage[]}>} */ (new Map()),
    lastError: /** @type {string|null} */ (null),
    startedAt: /** @type {string|null} */ (null),
  };
  const snapshotOf = () => ({
    name: st.name,
    platform: st.platform,
    state: st.state,
    tools: st.tools,
    toolDefs: st.toolDefs,
    channels: [...st.channels.values()],
    grant: st.grant,
    lastError: st.lastError,
    startedAt: st.startedAt,
  });

  /** @type {import("./wire.mjs").Wire|null} */
  let wire = null;
  let stopped = false;
  let backoff = backoffMs.min;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let restartTimer = null;
  let everReady = false; // reset every connect() — this attempt only
  const remember = seenWindow();
  const say = (line) => log(`[child:${server.name}] ${line}`);
  const safely = (fn, what) => {
    try {
      fn();
    } catch (e) {
      say(`${what} threw: ${e?.message ?? e}`);
    }
  };

  /** every push/event and channels/incoming is accepted at once (see the
   * header) — the dedupe window still applies so a redelivered id doesn't
   * reach `onIncoming` twice. */
  function deliver(msg) {
    if (remember(msg.eventId)) safely(() => onIncoming(msg), "onIncoming");
    return { accepted: true };
  }

  async function handleRequest(method, params) {
    switch (method) {
      case METHOD.PUSH_EVENT:
        return deliver(normalizePush(params));
      case METHOD.CHANNELS_INCOMING: {
        const messages = Array.isArray(params?.messages) ? params.messages : [];
        const results = messages.map((m) => {
          const norm = normalizeIncoming(m);
          deliver(norm);
          return { messageId: norm.messageId, accepted: true };
        });
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
        safely(() => onChannels([...st.channels.values()]), "onChannels");
        return { results };
      }
      case METHOD.INFERENCE_REQUEST:
        say(`inference/request from feature set ${params?.featureSet ?? "?"} — recorded, not run`);
        safely(() => onNotification(method, params), "onNotification");
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
    if (method === METHOD.CHANNELS_CHANGED) {
      void handleRequest(method, params);
      return;
    }
    if (method === METHOD.MCPL_MANIFEST_CHANGED)
      say(`manifest changed (revision ${params?.revision ?? "?"}) — noted; the grant is unchanged`);
    safely(() => onNotification(method, params), "onNotification");
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
    if (hist.length) safely(() => onHistory(channelId, hist), "onHistory");
    return r;
  }

  async function handshake() {
    if (!wire) return;
    const init = /** @type {any} */ (
      await wire.request(METHOD.INITIALIZE, {
        protocolVersion: "2024-11-05",
        capabilities: { experimental: { mcpl: HOST_MCPL } },
        clientInfo: { name: "connectome-being", version: hostVersion },
      })
    );
    const caps = init?.capabilities ?? {};
    const manifest = caps?.experimental?.mcpl ?? null;
    st.revision = manifest ? manifestRevision(manifest) : null;
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
    if (receipt?.accepted === false) {
      st.state = receipt.fallback === "close" ? "stopped" : "mcp-only";
      say(`grant refused (${receipt.fallback ?? "?"}): ${receipt.reason ?? ""} — never widened`);
      if (receipt.fallback === "close") {
        stopped = true;
        wire.close();
      }
      return;
    }
    st.state = receipt?.mode === "degraded" ? "degraded" : "ready";
    try {
      const tl = /** @type {any} */ (await wire.request("tools/list", {}));
      st.toolDefs = Array.isArray(tl?.tools) ? tl.tools.filter((t) => t?.name) : [];
      st.tools = st.toolDefs.map((t) => t.name);
    } catch (e) {
      say(`tools/list failed: ${e.message}`);
    }
    everReady = true;
    safely(() => onReady(snapshotOf()), "onReady");
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMs.max);
    say(`restarting in ${wait}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void connect();
    }, wait);
    restartTimer.unref?.();
  }

  async function connect() {
    if (stopped) return;
    st.state = "starting";
    st.open.clear();
    st.channels.clear();
    everReady = false;
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
      onExit({ code: null, signal: null, everReady: false });
      scheduleRestart();
      return;
    }
    const w = wire;
    w.onRequest(handleRequest);
    w.onNotification(handleNotification);
    w.onClose(({ code, signal }) => {
      if (wire !== w) return;
      wire = null;
      const wasReady = everReady;
      if (stopped) {
        st.state = "stopped";
        return;
      }
      st.state = "crashed";
      st.lastError = `child exited (code ${code}, signal ${signal})`;
      say(st.lastError);
      onExit({ code, signal, everReady: wasReady });
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

  function notifyIfGranted(cap, method, params) {
    if (wire && !wire.isClosed() && (!cap || st.grant.includes(cap))) wire.notify(method, params);
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
    openChannel,
    /** the grant gates every call, exactly as host.mjs's own callTool. */
    async callTool(name, args) {
      const refusal = callRefusal(st, name);
      if (refusal) throw new GrantRefused(refusal);
      if (!wire || wire.isClosed()) throw new Error("not connected");
      return wire.request("tools/call", { name, arguments: args });
    },
    /** the generic `platform.notify` (house -> being) passthrough: gated
     * when this method's capability is known (typing, lifecycle), sent
     * ungated (logged) otherwise — the wire carries no capability name. */
    notify(method, params) {
      const cap = CAPABILITY_FOR_METHOD[method];
      if (cap === undefined) say(`notify ${method}: no known capability gate — sent ungated`);
      notifyIfGranted(cap ?? null, method, params);
    },
    typing(channelId, on = true) {
      const t = adapterFor(server.platform).typing(channelId, on);
      notifyIfGranted(t.capability, t.method, t.params);
    },
    connected: () => !!wire && !wire.isClosed(),
    snapshot: snapshotOf,
  };
}

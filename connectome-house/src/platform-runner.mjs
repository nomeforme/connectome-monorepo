// @ts-check
/* connectome-house/src/platform-runner.mjs — the being side of harness-
 * port phase W6 ("the seat moves into the being", docs/harness-port/
 * 13-walker-port.md §4): for every servers-file entry whose `being` is
 * THIS being, spawns its MCPL child (mcpl/child.mjs) and bridges it to
 * the house over the SAME seat socket walker.mjs already holds — turns
 * and platform traffic multiplexed by message type, one connection per
 * being, so a house restart never touches a live platform connection.
 *
 * Env names resolve from the process env at spawn time (mcpl/wire.mjs's
 * own `childEnv`, unchanged, invoked inside child.mjs); `${VAR}` inside a
 * room's `stream` is the house's own concern (config-env.mjs) — this
 * module never expands a room, only reads `name`/`platform`/`command`/
 * `args`/`cwd`/`env` per matching server (config.mjs's own
 * `validateServer`, read-only — never edited here).
 *
 * Buffering: while `seat.isLive()` is false, every being->house send this
 * module makes (platform.incoming/history/channels/child/result) queues
 * in one bounded FIFO instead of being silently dropped; past
 * `bufferLimit` the OLDEST entry is dropped, one stderr line naming the
 * running total. `platform.hello` is never buffered — a stale hello could
 * describe a child whose state has since moved on, so on reseat
 * (`isLive()` false -> true, the only signal either transport gives; both
 * StdioSeat and SeatClient expose per-message-type handlers but no
 * "reconnected" event of their own, hence the poll) a FRESH hello goes
 * out for every currently ready/degraded child, and only then does the
 * buffer flush, in order. */
import { readFileSync } from "node:fs";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";
import { validateServer } from "./mcpl/config.mjs";
import { spawnChild as defaultSpawnChild } from "./mcpl/child.mjs";

/** @typedef {{name: string, platform: string, command: string, args?: string[], cwd?: string, env?: string[]}} SpawnEntry */

/** a servers file -> this being's OWN entries, spawn-shaped fields only
 * (never `rooms`/`rooms_policy`/`box` — the house's own routing concerns).
 * A malformed entry or one naming another being is skipped quietly: the
 * house's own `loadServersConfig` is what reports malformed entries; this
 * being only ever spawns what is unambiguously its own.
 * @param {string} serversFile @param {string} being @returns {SpawnEntry[]} */
export function loadOwnServers(serversFile, being) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(serversFile, "utf8"));
  } catch (e) {
    throw new Error(`platform-runner: ${serversFile}: ${e instanceof Error ? e.message : e}`);
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
  /** @type {SpawnEntry[]} */
  const out = [];
  for (const entry of list) {
    const v = validateServer(entry);
    if (typeof v === "string" || v.being !== being) continue;
    out.push({ name: v.name, platform: v.platform, command: v.command, args: v.args, cwd: v.cwd, env: v.env });
  }
  return out;
}

/**
 * @param {{serversFile?: string, servers?: SpawnEntry[], being: string,
 *   seat: {send: (msg: Record<string, unknown>) => boolean,
 *     on: (type: string, fn: (msg: any) => void) => void, isLive: () => boolean},
 *   log?: (line: string) => void, bufferLimit?: number, reseatPollMs?: number,
 *   spawnChildFn?: typeof defaultSpawnChild}} opts
 *   `servers`, when given, is used verbatim instead of reading/validating
 *   `serversFile` (tests; a caller that already resolved the list).
 * @returns {{handles: Map<string, ReturnType<typeof defaultSpawnChild>>, stop: () => void}} */
export function startPlatformRunner({
  serversFile,
  servers,
  being,
  seat,
  log = () => {},
  bufferLimit = 500,
  reseatPollMs = 200,
  spawnChildFn = defaultSpawnChild,
}) {
  const say = (line) => log(`[platform-runner] ${line}`);
  const list = servers ?? (serversFile ? loadOwnServers(serversFile, being) : []);
  /** @type {Map<string, ReturnType<typeof defaultSpawnChild>>} */
  const handles = new Map();
  /** @type {Record<string, unknown>[]} */
  const buffer = [];
  let dropped = 0;

  /** send now if the seat is live and the write succeeds; otherwise queue. */
  function sendOrBuffer(msg) {
    if (seat.isLive() && seat.send(msg)) return;
    buffer.push(msg);
    if (buffer.length > bufferLimit) {
      buffer.shift();
      dropped += 1;
      say(`house socket down — buffer full (${bufferLimit}), dropped oldest (${dropped} dropped total)`);
    }
  }

  /** replay the buffer in order, stopping (leaving the rest queued) the
   * moment a send fails again — never reorders, never drops on flush. */
  function flushBuffer() {
    while (buffer.length) {
      if (!(seat.isLive() && seat.send(buffer[0]))) break;
      buffer.shift();
    }
  }

  /** @param {string} name @param {ReturnType<ReturnType<typeof defaultSpawnChild>["snapshot"]>} snap */
  function sendHello(name, snap) {
    const ok =
      seat.isLive() &&
      seat.send({
        type: "platform.hello",
        room: PLATFORM_ROOM,
        server: name,
        platform: snap.platform,
        being,
        tools: snap.tools,
        channels: snap.channels,
        capabilities: { grant: snap.grant, mode: snap.state },
      });
    if (!ok) say(`hello for ${name} not sent (house is down) — a fresh one goes out on reseat`);
    return ok;
  }

  for (const server of list) {
    const handle = spawnChildFn(server, {
      log: say,
      onIncoming: (msg) =>
        sendOrBuffer({ type: "platform.incoming", room: PLATFORM_ROOM, server: server.name, msg }),
      onHistory: (channelId, messages) =>
        sendOrBuffer({ type: "platform.history", room: PLATFORM_ROOM, server: server.name, channelId, messages }),
      onChannels: (channels) =>
        sendOrBuffer({ type: "platform.channels", room: PLATFORM_ROOM, server: server.name, channels }),
      onExit: (info) =>
        sendOrBuffer({
          type: "platform.child",
          room: PLATFORM_ROOM,
          server: server.name,
          state: info.everReady ? "exited" : "failed",
          detail: `code=${info.code ?? "null"} signal=${info.signal ?? "null"}`,
        }),
      // fires on every successful handshake, first start AND every
      // automatic restart — see the module header on why "starting" is
      // announced only once (the initial spawn below) but "ready" always is.
      onReady: (snap) => {
        sendOrBuffer({ type: "platform.child", room: PLATFORM_ROOM, server: server.name, state: "ready" });
        sendHello(server.name, snap);
      },
    });
    handles.set(server.name, handle);
    sendOrBuffer({ type: "platform.child", room: PLATFORM_ROOM, server: server.name, state: "starting" });
    void handle.start();
  }

  // reseat detection: the only signal either seat transport gives for
  // "the house is back" is isLive() flipping false -> true (walker.mjs's
  // own keep-alive check polls the same way, at a coarser 5000ms).
  let wasLive = seat.isLive();
  const reseatTimer = setInterval(() => {
    const live = seat.isLive();
    if (live && !wasLive) {
      say(`seat reseated — resending hello for every ready child, flushing ${buffer.length} buffered message(s)`);
      for (const [name, handle] of handles) {
        if (handle.state.state === "ready" || handle.state.state === "degraded") sendHello(name, handle.snapshot());
      }
      flushBuffer();
    }
    wasLive = live;
  }, reseatPollMs);
  reseatTimer.unref?.();

  seat.on("platform.call", async (msg) => {
    const { server: serverName, id, name: toolName, args } = msg;
    const handle = handles.get(serverName);
    if (!handle) {
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: false, error: `no such server ${serverName}` });
      return;
    }
    try {
      const result = await handle.callTool(toolName, args);
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: true, result });
    } catch (e) {
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: false, error: e?.message ?? String(e) });
    }
  });

  seat.on("platform.open", async (msg) => {
    const { server: serverName, id, channelId, history } = msg;
    const handle = handles.get(serverName);
    if (!handle) {
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: false, error: `no such server ${serverName}` });
      return;
    }
    try {
      const result = await handle.openChannel(channelId, history ? { history: history.limit ?? 0 } : {});
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: true, result });
    } catch (e) {
      sendOrBuffer({ type: "platform.result", room: PLATFORM_ROOM, server: serverName, id, ok: false, error: e?.message ?? String(e) });
    }
  });

  seat.on("platform.notify", (msg) => {
    const { server: serverName, method, params } = msg;
    const handle = handles.get(serverName);
    if (handle) handle.notify(method, params ?? {});
    else say(`platform.notify for unknown server ${serverName} — dropped`);
  });

  return {
    handles,
    stop() {
      clearInterval(reseatTimer);
      for (const handle of handles.values()) handle.stop();
    },
  };
}

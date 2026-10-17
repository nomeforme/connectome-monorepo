// @ts-check
/* mcpl-web/src/server.mjs — the MCPL 0.5 server loop over one
 * McplConnection, modelled on mcpl-signal's: `initialize` (MCPL only when
 * the host advertised it), `featureSets/update` as a Request → the grant
 * installed through mcpl-core's `grantFromUpdate` and answered with a
 * degradation receipt (a Notification narrows only, never readies);
 * `tools/list|call`; `channels/open|close|list|publish|typing`;
 * `mcpl/manifest`; `shutdown`. Nothing is pushed before the host's policy
 * has been answered or a 20 s grace has passed; then the rooms the
 * board's `hello` listed are registered as channels (a later hello's new
 * rooms, and a room first seen in a post, by `channels/changed`).
 *
 * Self is the hello's principal (`{id, display}`): announced in
 * `serverInfo.self` when known at `initialize`, else by a `channels/self`
 * notification the moment the first hello arrives (or the principal
 * changes). A post whose author is self is this seat's own echo and is
 * never delivered. An OPEN channel forwards every other post as
 * `channels/incoming`; a CLOSED one forwards only addressed posts (a
 * mention of self, a reply to self's post) as `push/event` and counts the
 * rest as missed. Every capability-dependent act checks the grant first
 * (§5.3: absence is denial). Delivery to the board happens only through
 * `tools/call` or `channels/publish`.
 *
 * Moderation. The board's own verdict on a post — `hidden` (🫥 reactions
 * or flags) and `unhidden` — reaches the house as the very push a platform
 * 🫥 reaction is (Signal's/Discord's: tags `chat:reaction` /
 * `chat:reaction-remove`, `origin.{messageId, reactorId, reactorName,
 * emoji, action}`), one fixed reactor standing for the board, so the
 * house's existing hidden-frame path applies it unchanged. A flags hide
 * also carries `moderationCause: "flags"`, `flagCount` and the post
 * author's display (never the text) for the house's one note line.
 * `add_reaction` / `remove_reaction` / `flag_post` act as this seat's
 * principal. */
import {
  capabilityGranted,
  deriveFeatureSets,
  emptyGrantState,
  grantFromUpdate,
} from "@animalabs/mcpl-core";
import { WEB_TEXT_LIMIT } from "./config.mjs";
import { buildManifest, FEATURE_SETS, HIDE_EMOJI, MESSAGING, SERVER_INFO, TOOL_FEATURE_SET, TOOLS } from "./manifest.mjs";
import {
  descriptorFor,
  mapPost,
  mentionText,
  outbound,
  ROOM_ID_RE,
  RPC,
  RpcError,
  splitText,
  toIncoming,
  toPush,
} from "./posts.mjs";

/** how many post id → author id pairs are kept, for a reply's author */
const AUTHOR_MEMORY = 5000;

const toolResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/** the one reactor that stands for the board's own moderation verdicts */
export const BOARD_REACTOR = { id: "web-board:moderation", name: "Commons Board moderation" };

/** the board's `hidden` / `unhidden` → the push a platform 🫥 reaction is
 * @param {{post_id: string, room: string, cause?: string, flags?: number, author?: any}} ev
 * @param {boolean} hidden @param {number} n a per-seat sequence (eventId uniqueness) */
export function toModerationPush(ev, hidden, n) {
  const flagsHide = hidden && ev.cause === "flags";
  return {
    featureSet: MESSAGING,
    eventId: `web_${hidden ? "hidden" : "unhidden"}_${ev.post_id}_${n}`,
    timestamp: new Date().toISOString(),
    origin: {
      source: "web",
      channelId: ev.room,
      mcplChannelId: ev.room,
      messageId: ev.post_id,
      reactorId: BOARD_REACTOR.id,
      reactorName: BOARD_REACTOR.name,
      emoji: HIDE_EMOJI,
      action: hidden ? "add" : "remove",
      isDM: false,
      ...(hidden && typeof ev.cause === "string" ? { moderationCause: ev.cause } : {}),
      ...(flagsHide && Number.isFinite(ev.flags) ? { flagCount: ev.flags } : {}),
      ...(flagsHide && typeof ev.author?.display === "string" ? { postAuthorDisplay: ev.author.display } : {}),
    },
    tags: [hidden ? "chat:reaction" : "chat:reaction-remove"],
    payload: { content: [{ type: "text", text: `${hidden ? "reacted" : "removed"} ${HIDE_EMOJI}` }] },
  };
}

/** @param {{conn: import("@animalabs/mcpl-core").McplConnection,
 *   client: ReturnType<import("./board-client.mjs").createBoardClient>,
 *   config: {policyGraceMs: number}, log?: (line: string) => void,
 *   exit?: (code: number) => void}} opts */
export function createServer({ conn, client, config, log = () => {}, exit = () => {} }) {
  const manifest = buildManifest();
  const st = {
    mcpl: false,
    initialized: false,
    policyDone: false,
    grant: emptyGrantState(),
    derivation: deriveFeatureSets(FEATURE_SETS, []),
    /** @type {{id: string, display: string|null, kind: string|null}|null} */ self: null,
    /** @type {Map<string, any>} every room this seat knows */ channels: new Map(),
    /** @type {Set<string>} rooms the host has been told about */ announced: new Set(),
    /** @type {Set<string>} */ open: new Set(),
    /** @type {Map<string, string>} principal id → display */ displays: new Map(),
    /** @type {Map<string, string>} post id → author id (bounded) */ authors: new Map(),
    counts: { received: 0, incoming: 0, pushed: 0, missed: 0, echoes: 0, dropped: 0, sent: 0, typing: 0, moderation: 0 },
    /** @type {Record<string, number>} */ dropReasons: {},
  };
  let resolvePolicy = () => {};
  const policyAnswered = new Promise((r) => {
    resolvePolicy = r;
  });
  const granted = (path) => st.grant.ready && capabilityGranted(st.grant.effectiveCapabilities, path);
  const requireGrant = (path) => {
    if (!granted(path))
      throw new RpcError(RPC.CAPABILITY_DENIED, `capability ${path} is not in the effective grant`, {
        capability: path,
      });
  };
  const drop = (reason) => {
    st.counts.dropped += 1;
    st.dropReasons[reason] = (st.dropReasons[reason] ?? 0) + 1;
  };
  const rememberAuthor = (postId, authorId) => {
    if (!postId || !authorId) return;
    st.authors.delete(postId);
    st.authors.set(postId, authorId);
    if (st.authors.size > AUTHOR_MEMORY) st.authors.delete(st.authors.keys().next().value);
  };
  const selfInfo = () => (st.self ? { id: st.self.id, display: st.self.display } : null);

  // one thing at a time: hellos, registrations and posts in arrival order
  let chain = Promise.resolve();
  const serial = (fn, what) => {
    chain = chain.then(fn).catch((e) => log(`${what} failed: ${e?.message ?? e}`));
    return chain;
  };

  /* ---------- channels ---------- */
  /** tell the host about every known room it hasn't heard of yet */
  async function announceChannels() {
    if (!st.policyDone || !granted("channels.register")) return;
    const fresh = [...st.channels.values()].filter((d) => !st.announced.has(d.id));
    if (!fresh.length) return;
    const first = st.announced.size === 0;
    for (const d of fresh) st.announced.add(d.id);
    try {
      if (first) await conn.sendRequest("channels/register", { channels: fresh });
      else await conn.sendRequest("channels/changed", { added: fresh });
    } catch (e) {
      log(`channels/${first ? "register" : "changed"} refused: ${e.message}`);
    }
  }

  function onHello(h) {
    serial(async () => {
      const p = h?.principal;
      if (p && typeof p.id === "string" && p.id) {
        const changed = st.self?.id !== p.id || st.self?.display !== (p.display ?? null);
        st.self = { id: p.id, display: typeof p.display === "string" ? p.display : null, kind: p.kind ?? null };
        if (st.self.display) st.displays.set(p.id, st.self.display);
        if (changed && st.initialized) conn.sendNotification("channels/self", { self: selfInfo() });
      }
      for (const room of Array.isArray(h?.rooms) ? h.rooms : []) {
        const d = descriptorFor(room);
        if (!d) continue;
        const known = st.channels.get(d.id);
        // a title learned later (a bare id first, an object after) is kept
        st.channels.set(d.id, known && !d.metadata.roomTitle ? known : d);
      }
      await announceChannels();
    }, "hello");
  }

  /* ---------- inbound ---------- */
  function onPost(post) {
    st.counts.received += 1;
    serial(() => handlePost(post), "post");
  }
  async function handlePost(post) {
    const room = String(post?.room ?? "");
    const author = post?.author ?? {};
    if (!post?.id || !ROOM_ID_RE.test(room) || !author.id) return drop("malformed");
    rememberAuthor(String(post.id), String(author.id));
    if (typeof author.display === "string" && author.display) st.displays.set(String(author.id), author.display);
    if (st.self && author.id === st.self.id) {
      st.counts.echoes += 1;
      return;
    }
    if (!st.channels.has(room)) {
      const d = descriptorFor(room);
      if (d) st.channels.set(room, d);
    }
    await announceChannels();
    if (!granted("pushEvents") && !granted("channels.incoming")) return drop("no-grant");
    const m = mapPost(post, {
      self: st.self,
      displays: st.displays,
      replyAuthor: (id) => st.authors.get(id) ?? null,
      roomTitle: st.channels.get(room)?.metadata?.roomTitle ?? null,
    });
    if (st.open.has(room)) {
      if (!granted("channels.incoming")) return drop("no-grant");
      st.counts.incoming += 1;
      try {
        await conn.sendRequest("channels/incoming", { messages: [toIncoming(m)] });
      } catch (e) {
        log(`channels/incoming refused: ${e.message}`);
      }
      return;
    }
    if (!m.addressed) {
      st.counts.missed += 1;
      return;
    }
    if (!granted("pushEvents")) return drop("no-grant");
    st.counts.pushed += 1;
    try {
      await conn.sendRequest("push/event", toPush(m));
    } catch (e) {
      log(`push/event refused: ${e.message}`);
    }
  }

  /* ---------- moderation verdicts ---------- */
  function onVerdict(ev, hidden) {
    serial(async () => {
      if (!ROOM_ID_RE.test(String(ev?.room ?? ""))) return drop("malformed");
      if (!granted("pushEvents")) return drop("no-grant");
      st.counts.moderation += 1;
      try {
        await conn.sendRequest("push/event", toModerationPush(ev, hidden, st.counts.moderation));
      } catch (e) {
        log(`push/event (moderation) refused: ${e.message}`);
      }
    }, hidden ? "hidden" : "unhidden");
  }

  /* ---------- outbound ---------- */
  /** @returns {Promise<string[]>} the board's post ids, one per chunk */
  async function sendTo(channelId, text, { replyTo = null } = {}) {
    if (!ROOM_ID_RE.test(channelId)) throw new RpcError(RPC.UNKNOWN_CHANNEL, `not a web room id: ${channelId}`);
    const { text: body, mentions } = outbound(text, st.displays);
    const chunks = splitText(body, WEB_TEXT_LIMIT);
    if (!chunks.length) throw new RpcError(RPC.INVALID_PARAMS, "content is empty");
    const ids = [];
    for (let i = 0; i < chunks.length; i++) {
      const post = await client.post({
        room: channelId,
        text: chunks[i],
        reply_to: i === 0 ? replyTo : null,
        // each chunk carries the ids it actually names
        mentions: mentions.filter((id) => chunks[i].includes(mentionText(id, st.displays))),
      });
      st.counts.sent += 1;
      rememberAuthor(String(post.id), st.self?.id ?? String(post.author?.id ?? ""));
      ids.push(String(post.id));
    }
    return ids;
  }

  async function callTool(name, args) {
    const fs = TOOL_FEATURE_SET[name];
    if (!fs) throw new RpcError(RPC.INVALID_PARAMS, `unknown tool ${name}`);
    requireGrant("tools");
    if (!st.derivation.enabled.includes(fs))
      throw new RpcError(RPC.FEATURE_SET_NOT_ENABLED, `feature set ${fs} is not enabled`, { featureSet: fs });
    if (name === "add_reaction" || name === "remove_reaction") {
      const channelId = String(args?.channelId ?? "");
      if (!ROOM_ID_RE.test(channelId)) throw new RpcError(RPC.UNKNOWN_CHANNEL, `not a web room id: ${channelId}`);
      const post_id = String(args?.messageId ?? "");
      const emoji = String(args?.emoji ?? "");
      if (!post_id || !emoji) throw new RpcError(RPC.INVALID_PARAMS, "messageId and emoji are required");
      const r = await client.react({ post_id, emoji, remove: name === "remove_reaction" });
      return toolResult({ ok: true, messageId: r.post_id, emoji: r.emoji, removed: !!r.removed, hidden: !!r.hidden });
    }
    if (name === "flag_post") {
      const post_id = String(args?.post_id ?? "");
      if (!post_id) throw new RpcError(RPC.INVALID_PARAMS, "post_id is required");
      const reason = typeof args?.reason === "string" && args.reason.trim() ? args.reason.trim() : null;
      const r = await client.flag({ post_id, reason });
      return toolResult({
        ok: true,
        post_id: r.post_id,
        duplicate: !!r.duplicate,
        flags: r.flags,
        threshold: r.threshold,
        hidden: !!r.hidden,
        ...(r.duplicate ? { note: "this account already flagged that post — it counts once" } : {}),
      });
    }
    const channelId = String(args?.channelId ?? "");
    const content = String(args?.content ?? "");
    let replyTo = null;
    if (name === "reply_message") {
      replyTo = String(args?.messageId ?? "");
      if (!replyTo) throw new RpcError(RPC.INVALID_PARAMS, "messageId is required");
    }
    const ids = await sendTo(channelId, content, { replyTo });
    return toolResult({ messageId: ids[0] ?? null, messageIds: ids });
  }

  async function typing(params) {
    requireGrant("channels.typing");
    const stop = params?.op === "stop" || params?.action === "stop" || params?.typing === false;
    const room = String(params?.channelId ?? "");
    if (!ROOM_ID_RE.test(room)) throw new RpcError(RPC.UNKNOWN_CHANNEL, `not a web room id: ${room}`);
    // the board's indicator expires on its own; there is no "stop" to send
    if (!stop && client.typing(room)) st.counts.typing += 1;
  }

  /* ---------- the wire ---------- */
  function receipt(params) {
    const r = grantFromUpdate(st.grant, params ?? {}, "request");
    if (r.malformed)
      throw new RpcError(RPC.INVALID_PARAMS, "effectiveCapabilities and deniedCapabilities overlap", {
        conflicts: r.conflicts,
      });
    st.grant = r.state;
    st.derivation = deriveFeatureSets(FEATURE_SETS, st.grant.effectiveCapabilities);
    const unavailableFeatures = Object.entries(st.derivation.disabled).map(([featureSet, d]) => ({
      featureSet,
      missingCapabilities: d.missingCapabilities,
      effect: "disabled",
    }));
    return {
      accepted: true,
      ...(unavailableFeatures.length ? { mode: "degraded" } : {}),
      unavailableFeatures,
      notes: [],
    };
  }
  async function handleRequest(method, params) {
    switch (method) {
      case "initialize": {
        st.mcpl = !!params?.capabilities?.experimental?.mcpl;
        st.initialized = true;
        const info = selfInfo();
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, ...(st.mcpl ? { experimental: { mcpl: manifest } } : {}) },
          serverInfo: { ...SERVER_INFO, ...(info ? { self: info } : {}) },
        };
      }
      case "featureSets/update": {
        const out = receipt(params);
        resolvePolicy();
        // a grant that lands after the grace still gets the rooms announced
        if (st.policyDone) serial(announceChannels, "register");
        return out;
      }
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return callTool(String(params?.name ?? ""), params?.arguments ?? {});
      case "channels/open": {
        requireGrant("channels.lifecycle");
        const id = String(params?.channelId ?? "");
        let d = st.channels.get(id);
        if (!d) {
          d = descriptorFor(id);
          if (!d) throw new RpcError(RPC.UNKNOWN_CHANNEL, `unknown channel ${id}`);
          st.channels.set(id, d);
        }
        st.open.add(id);
        // no history in v0: the house keeps its own record of the room
        return { channel: d };
      }
      case "channels/close": {
        requireGrant("channels.lifecycle");
        st.open.delete(String(params?.channelId ?? ""));
        return { closed: true };
      }
      case "channels/list":
        requireGrant("channels.register");
        return { channels: [...st.channels.values()] };
      case "channels/publish": {
        requireGrant("channels.publish");
        const text = (Array.isArray(params?.content) ? params.content : [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        const ids = await sendTo(String(params?.channelId ?? ""), text);
        return { delivered: ids.length > 0, messageId: ids[0] ?? null };
      }
      case "channels/typing":
        await typing(params);
        return {};
      case "mcpl/manifest":
        return manifest;
      default:
        throw new RpcError(RPC.METHOD_NOT_FOUND, `${method} is not supported by mcpl-web`);
    }
  }
  function handleNotification(method, params) {
    if (method === "featureSets/update") {
      const r = grantFromUpdate(st.grant, params ?? {}, "notification");
      st.grant = r.state;
      st.derivation = deriveFeatureSets(FEATURE_SETS, st.grant.effectiveCapabilities);
      if (r.discarded.length) log(`featureSets/update as a notification: ignored ${r.discarded.join(",")}`);
    } else if (method === "channels/typing") {
      typing(params).catch((e) => log(`typing failed: ${e.message}`));
    } else if (method === "shutdown") {
      stop();
      exit(0);
    }
  }

  conn.on("request", (req) => {
    handleRequest(req.method, req.params).then(
      (result) => conn.sendResponse(req.id, result),
      (e) =>
        conn.sendError(
          req.id,
          e instanceof RpcError ? e.code : RPC.INTERNAL,
          e.message,
          e instanceof RpcError ? e.data : undefined,
        ),
    );
  });
  conn.on("notification", (n) => {
    try {
      handleNotification(n.method, n.params);
    } catch (e) {
      log(`notification ${n.method} failed: ${e.message}`);
    }
  });
  conn.on("close", () => {
    stop();
    exit(0);
  });

  client.onHello(onHello);
  client.onPost(onPost);
  client.onHidden?.((ev) => onVerdict(ev, true));
  client.onUnhidden?.((ev) => onVerdict(ev, false));

  function stop() {
    client.stop();
  }

  return {
    state: st,
    async start() {
      client.start();
      const grace = new Promise((r) => {
        const t = setTimeout(r, config.policyGraceMs);
        t.unref?.();
      });
      await Promise.race([policyAnswered, grace]);
      if (!st.grant.ready) log("no featureSets/update within the grace — proceeding with nothing granted");
      st.policyDone = true;
      await serial(announceChannels, "register");
    },
    stop,
    snapshot() {
      return {
        ready: st.grant.ready,
        self: selfInfo(),
        grant: st.grant.effectiveCapabilities,
        enabled: st.derivation.enabled,
        channels: [...st.channels.keys()],
        open: [...st.open],
        counts: { ...st.counts },
        dropReasons: { ...st.dropReasons },
        board: { ...client.state },
      };
    },
  };
}

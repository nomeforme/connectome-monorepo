// @ts-check
/* mcpl-signal/src/server.mjs — the MCPL 0.5 server loop over one
 * McplConnection: `initialize` (MCPL only when the host advertised it),
 * `featureSets/update` as a Request → the grant installed through
 * mcpl-core's `grantFromUpdate` and answered with a degradation receipt
 * (a Notification narrows only, never readies); `tools/list|call`;
 * `channels/open|close|list|publish|typing`; `mcpl/manifest`;
 * `shutdown`. Nothing is pushed before the host's policy has been
 * answered or a 20 s grace has passed (a known deadlock otherwise);
 * then the account's groups are registered as channels, DMs lazily by
 * `channels/changed` on first sight. An OPEN channel forwards everything
 * as `channels/incoming`; a CLOSED one forwards only addressed traffic
 * (mention, quote of this account, DM) as `push/event` and counts the
 * rest as missed. Every capability-dependent act checks the grant first
 * (§5.3: absence is denial). Delivery to Signal happens only through
 * `tools/call` or `channels/publish` — never on a lifecycle notification
 * (§14.5). */
import {
  capabilityGranted,
  deriveFeatureSets,
  emptyGrantState,
  grantFromUpdate,
} from "@animalabs/mcpl-core";
import { dmDescriptor, groupDescriptor, RPC, RpcError } from "./channels.mjs";
import {
  isUuid,
  mapEnvelope,
  parseChannelId,
  toDeletePush,
  toEditPush,
  toIncoming,
  toPush,
  toReactionPush,
} from "./envelopes.mjs";
import { buildManifest, FEATURE_SETS, SERVER_INFO, TOOLS } from "./manifest.mjs";
import { createDedup, createPrivacy } from "./privacy.mjs";
import { createTools } from "./tools.mjs";

const IMAGE_MIMES = /^image\/(png|jpe?g|gif|webp)$/i;

/** @param {{conn: import("@animalabs/mcpl-core").McplConnection,
 *   client: ReturnType<import("./signal-cli.mjs").createSignalCli>,
 *   config: import("./config.mjs").SignalConfig, log?: (line: string) => void,
 *   exit?: (code: number) => void}} opts */
export function createServer({ conn, client, config, log = () => {}, exit = () => {} }) {
  const manifest = buildManifest();
  const self = { number: config.number, uuid: /** @type {string|null} */ (null) };
  const st = {
    mcpl: false,
    grant: emptyGrantState(),
    derivation: deriveFeatureSets(FEATURE_SETS, []),
    /** @type {Map<string, any>} */ channels: new Map(),
    /** @type {Set<string>} */ open: new Set(),
    /** @type {Map<string, string>} uuid → profile name */ names: new Map(),
    /** PRIVATE: digest id → number, so a phone-only contact can be answered;
     * never serialized, never sent to the host */
    /** @type {Map<string, string>} */ numbers: new Map(),
    counts: { received: 0, incoming: 0, pushed: 0, missed: 0, dropped: 0, sent: 0, deduped: 0 },
    /** @type {Record<string, number>} */ dropReasons: {},
  };
  const dedup = createDedup();
  const privacy = createPrivacy({
    mode: config.privacyMode,
    file: config.privacyFile,
    allowedGroups: config.allowedGroups,
    log,
  });
  let resolvePolicy = () => {};
  const policyAnswered = new Promise((r) => {
    resolvePolicy = r;
  });
  const granted = (path) =>
    st.grant.ready && capabilityGranted(st.grant.effectiveCapabilities, path);
  const requireGrant = (path) => {
    if (!granted(path))
      throw new RpcError(
        RPC.CAPABILITY_DENIED,
        `capability ${path} is not in the effective grant`,
        {
          capability: path,
        },
      );
  };
  const nameOf = (id) => st.names.get(id) ?? null;
  const drop = (reason) => {
    st.counts.dropped += 1;
    st.dropReasons[reason] = (st.dropReasons[reason] ?? 0) + 1;
  };
  const tools = createTools({
    client,
    config,
    self,
    names: st.names,
    numbers: st.numbers,
    counts: st.counts,
    enabled: () => st.derivation.enabled,
    requireGrant,
    log,
  });

  /* ---------- channels ---------- */
  async function registerGroups() {
    if (!granted("channels.register")) return;
    let groups = [];
    try {
      groups = await client.groups({ fresh: true });
    } catch (e) {
      log(`groups not listed (${e.message}) — channels register on first sight`);
    }
    const channels = groups.filter((g) => g?.internal_id).map(groupDescriptor);
    for (const d of channels) st.channels.set(d.id, d);
    if (!channels.length) return;
    try {
      await conn.sendRequest("channels/register", { channels });
    } catch (e) {
      log(`channels/register refused: ${e.message}`);
    }
  }
  async function ensureChannel(m) {
    if (st.channels.has(m.channelId)) return;
    const d = m.isDM
      ? dmDescriptor(m.channelId.slice("signal:dm:".length), m.fromSelf ? null : m.author.name)
      : groupDescriptor({ internal_id: m.groupId, name: m.groupName });
    st.channels.set(d.id, d);
    if (!granted("channels.register")) return;
    try {
      await conn.sendRequest("channels/changed", { added: [d] });
    } catch (e) {
      log(`channels/changed refused for ${d.id}: ${e.message}`);
    }
  }

  /* ---------- inbound ---------- */
  let chain = Promise.resolve();
  function onEnvelope(raw) {
    st.counts.received += 1;
    chain = chain
      .then(() => handleEnvelope(raw))
      .catch((e) => log(`envelope failed: ${e.message}`));
  }
  async function handleEnvelope(raw) {
    const m = mapEnvelope(raw, self);
    if (m.kind === "skip") return drop(m.reason);
    const dedupKey =
      m.kind === "reaction"
        ? `r:${m.messageId}`
        : m.kind === "edited"
          ? `ed:${m.messageId}`
          : m.kind === "deleted"
            ? `del:${m.messageId}`
            : m.messageId;
    if (!dedup(dedupKey)) {
      st.counts.deduped += 1;
      return;
    }
    if (m.author.name && isUuid(m.author.id)) st.names.set(m.author.id, m.author.name);
    if (m.number && !isUuid(m.author.id)) st.numbers.set(m.author.id, m.number);
    if (!granted("pushEvents") && !granted("channels.incoming")) return drop("no-grant");
    await ensureChannel(m);
    // an envelope's own groupInfo sometimes omits the name (signal-cli
    // version-dependent); the channel registry learned it at startup from
    // listGroups (registerGroups/groupDescriptor) — backfill from there
    // rather than forward a group the host can only ever call "a group".
    if (!m.groupName && m.groupId) {
      const known = st.channels.get(m.channelId)?.metadata?.groupName;
      if (known) m.groupName = known;
    }
    if (m.kind === "reaction") {
      if (!granted("pushEvents")) return drop("no-grant");
      await push(toReactionPush(m, self));
      return;
    }
    // edits and deletes act on a message the host may or may not have been
    // forwarded (privacy could have withheld the original) — they carry
    // that same uncertainty forward rather than re-deciding it: like a
    // reaction, they always go as a typed push/event naming the target
    // message id, never through channels/incoming and never gated by
    // privacy.admit (the house owns what "deleted"/"edited" means from here)
    if (m.kind === "deleted") {
      if (!granted("pushEvents")) return drop("no-grant");
      await push(toDeletePush(m, self));
      return;
    }
    if (m.kind === "edited") {
      if (!granted("pushEvents")) return drop("no-grant");
      const editImages = await inlineImages(m);
      await push(toEditPush(m, nameOf, editImages, 0));
      return;
    }
    const verdict = privacy.admit(m);
    if (!verdict.admit) return drop(verdict.reason);
    const images = await inlineImages(m);
    if (st.open.has(m.channelId)) {
      if (!granted("channels.incoming")) return drop("no-grant");
      st.counts.incoming += 1;
      try {
        await conn.sendRequest("channels/incoming", {
          messages: [toIncoming(m, nameOf, images, verdict.textOffset)],
        });
      } catch (e) {
        log(`channels/incoming refused: ${e.message}`);
      }
      return;
    }
    const addressed = m.isDM || m.mentionsSelf || m.quotesSelf;
    if (!addressed || m.fromSelf) {
      st.counts.missed += 1;
      return;
    }
    if (!granted("pushEvents")) return drop("no-grant");
    await push(toPush(m, nameOf, images, verdict.textOffset));
  }
  async function push(params) {
    st.counts.pushed += 1;
    try {
      await conn.sendRequest("push/event", params);
    } catch (e) {
      log(`push/event refused: ${e.message}`);
    }
  }
  async function inlineImages(m) {
    const out = [];
    for (const a of m.attachments) {
      if (!a.id || !IMAGE_MIMES.test(a.contentType)) continue;
      if (a.size != null && a.size > config.attachmentMaxBytes) continue;
      try {
        const bytes = await client.attachment(a.id);
        if (bytes.length > config.attachmentMaxBytes) continue;
        out.push({
          id: a.id,
          data: bytes.toString("base64"),
          mimeType: a.contentType,
          filename: a.filename ?? null,
          size: bytes.length,
        });
      } catch (e) {
        log(`attachment ${a.id} not fetched: ${e.message}`);
      }
    }
    return out;
  }

  /* ---------- the wire ---------- */
  function receipt(params) {
    const r = grantFromUpdate(st.grant, params ?? {}, "request");
    if (r.malformed)
      throw new RpcError(
        RPC.INVALID_PARAMS,
        "effectiveCapabilities and deniedCapabilities overlap",
        {
          conflicts: r.conflicts,
        },
      );
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
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, ...(st.mcpl ? { experimental: { mcpl: manifest } } : {}) },
          serverInfo: SERVER_INFO,
        };
      }
      case "featureSets/update": {
        const out = receipt(params);
        resolvePolicy();
        return out;
      }
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return tools.callTool(String(params?.name ?? ""), params?.arguments ?? {});
      case "channels/open": {
        requireGrant("channels.lifecycle");
        const id = String(params?.channelId ?? "");
        let d = st.channels.get(id);
        if (!d) {
          const p = parseChannelId(id);
          if (p?.kind !== "dm" || !p.id)
            throw new RpcError(RPC.UNKNOWN_CHANNEL, `unknown channel ${id}`);
          d = dmDescriptor(p.id, nameOf(p.id));
          st.channels.set(id, d);
        }
        st.open.add(id);
        // no history: signal-cli's receive socket is live only, and honesty
        // is an absent field, not an empty one
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
        const ids = await tools.sendTo(String(params?.channelId ?? ""), text);
        return { delivered: ids.length > 0, messageId: ids[0] ?? null };
      }
      case "channels/typing":
        await typing(params);
        return {};
      case "mcpl/manifest":
        return manifest;
      default:
        throw new RpcError(RPC.METHOD_NOT_FOUND, `${method} is not supported by mcpl-signal`);
    }
  }
  async function typing(params) {
    requireGrant("channels.typing");
    const stop = params?.op === "stop" || params?.action === "stop" || params?.typing === false;
    const recipient = await tools.recipientFor(String(params?.channelId ?? ""));
    await client.typing(recipient, !stop);
  }
  function handleNotification(method, params) {
    if (method === "featureSets/update") {
      const r = grantFromUpdate(st.grant, params ?? {}, "notification");
      st.grant = r.state;
      st.derivation = deriveFeatureSets(FEATURE_SETS, st.grant.effectiveCapabilities);
      if (r.discarded.length)
        log(`featureSets/update as a notification: ignored ${r.discarded.join(",")}`);
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

  function stop() {
    client.stop();
  }

  return {
    state: st,
    self,
    async start() {
      self.uuid = await client.selfUuid();
      client.receive(onEnvelope);
      const grace = new Promise((r) => {
        const t = setTimeout(r, config.policyGraceMs);
        t.unref?.();
      });
      await Promise.race([policyAnswered, grace]);
      if (!st.grant.ready)
        log("no featureSets/update within the grace — proceeding with nothing granted");
      await registerGroups();
    },
    stop,
    snapshot() {
      return {
        ready: st.grant.ready,
        grant: st.grant.effectiveCapabilities,
        enabled: st.derivation.enabled,
        channels: [...st.channels.keys()],
        open: [...st.open],
        counts: { ...st.counts },
        dropReasons: { ...st.dropReasons },
        privacy: privacy.snapshot(),
        socket: { ...client.state },
      };
    },
  };
}

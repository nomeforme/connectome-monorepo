// @ts-check
/* mcpl-signal/src/signal-cli.mjs — the client for signal-cli-rest-api
 * (bbernhard/signal-cli-rest-api, MODE=json-rpc): envelopes arrive on
 * `ws://<base>/v1/receive/<number>` (reconnect with backoff, 1 s → 60 s,
 * never a hot loop); everything else is REST — `POST /v2/send`
 * (recipients: a `group.<id>` external group id or a uuid/number; text,
 * mentions, quote, base64 attachments), `PUT /v1/typing-indicator/
 * <number>`, `GET /v1/groups/<number>` (the internal→external id map
 * the WS/send pair needs, cached), `GET /v1/attachments/<id>`,
 * `POST /v1/reactions/<number>`, `GET /v1/identities/<number>` (this
 * account's own uuid, when the endpoint answers). No dependency: Node's
 * global fetch and WebSocket. The account's number is a URL segment
 * here because the API wants it; it is never logged.
 *
 * Every path was read from the fork's axon and the API's docs, and
 * exercised only against the mock — see the README's "not verified". */

/** @typedef {{ok: boolean, status: number, json: () => Promise<any>, arrayBuffer: () => Promise<ArrayBuffer>}} Res */

/** @param {{baseUrl: string, wsUrl: string, number: string, log?: (line: string) => void,
 *   fetchImpl?: typeof fetch, WebSocketImpl?: typeof WebSocket,
 *   backoffMs?: {min: number, max: number}, connectTimeoutMs?: number, groupsTtlMs?: number}} opts */
export function createSignalCli({
  baseUrl,
  wsUrl,
  number,
  log = () => {},
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  backoffMs = { min: 1000, max: 60_000 },
  connectTimeoutMs = 15_000,
  groupsTtlMs = 60_000,
}) {
  const enc = encodeURIComponent(number);
  const state = {
    connected: false,
    reconnects: 0,
    lastError: /** @type {string|null} */ (null),
    received: 0,
  };
  /** @type {WebSocket|null} */
  let ws = null;
  let stopped = false;
  let backoff = backoffMs.min;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {((raw: any) => void)|null} */
  let onEnvelope = null;
  /** @type {{at: number, groups: any[]}|null} */
  let groupsCache = null;

  async function http(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* no body */
      }
      throw new Error(
        `signal-cli ${method} ${path.replace(enc, "<number>")} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res;
  }

  function connect() {
    if (stopped) return;
    let sock;
    try {
      sock = new WebSocketImpl(`${wsUrl}/v1/receive/${enc}`);
    } catch (e) {
      state.lastError = e.message;
      log(`receive socket failed to open: ${e.message}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    // a handshake that neither opens nor closes (signal-cli still starting
    // behind an accepting port) must not wedge the loop: give up on it and
    // retry — otherwise one hung attempt silences the account for good
    const openTimer = setTimeout(() => {
      if (ws !== sock || state.connected) return;
      log(`receive socket did not open within ${connectTimeoutMs} ms — retrying`);
      ws = null;
      try {
        sock.close();
      } catch {
        /* never opened */
      }
      scheduleReconnect();
    }, connectTimeoutMs);
    openTimer.unref?.();
    sock.addEventListener("open", () => {
      clearTimeout(openTimer);
      state.connected = true;
      backoff = backoffMs.min;
      log("receive socket connected");
    });
    sock.addEventListener("message", (ev) => {
      state.received += 1;
      let raw;
      try {
        raw = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      try {
        onEnvelope?.(raw);
      } catch (e) {
        log(`envelope handler threw: ${e.message}`);
      }
    });
    sock.addEventListener("error", (ev) => {
      state.lastError = /** @type {any} */ (ev)?.message ?? "socket error";
    });
    sock.addEventListener("close", () => {
      if (ws !== sock) return;
      ws = null;
      state.connected = false;
      if (!stopped) {
        log("receive socket closed");
        scheduleReconnect();
      }
    });
  }
  function scheduleReconnect() {
    if (stopped || timer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMs.max);
    state.reconnects += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, wait);
    timer.unref?.();
  }

  /** send one message; `recipient` is an external group id or a principal */
  async function send({ recipient, text, mentions, quote, attachments }) {
    const body = { number, recipients: [recipient], message: text ?? "", text_mode: "styled" };
    if (mentions?.length) body.mentions = mentions;
    if (quote) {
      body.quote_timestamp = quote.timestamp;
      body.quote_author = quote.author;
    }
    if (attachments?.length) body.base64_attachments = attachments;
    const res = await http("POST", "/v2/send", body);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* an empty body is a delivery without a timestamp */
    }
    const raw =
      data?.timestamp ??
      (Array.isArray(data?.results) ? data.results[0]?.timestamp : undefined) ??
      (Array.isArray(data) ? data[0]?.timestamp : undefined);
    const ts = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    return { timestamp: Number.isFinite(ts) ? ts : null };
  }

  return {
    state,
    receive(handler) {
      onEnvelope = handler;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const sock = ws;
      ws = null;
      try {
        sock?.close();
      } catch {
        /* not open */
      }
      state.connected = false;
    },
    send,
    async typing(recipient, started = true) {
      await http(started ? "PUT" : "DELETE", `/v1/typing-indicator/${enc}`, { recipient });
    },
    async react({ recipient, emoji, targetAuthor, timestamp, remove = false }) {
      await http(remove ? "DELETE" : "POST", `/v1/reactions/${enc}`, {
        recipient,
        reaction: emoji,
        target_author: targetAuthor,
        timestamp,
      });
    },
    /** [{id: external "group.<b64>", internal_id, name, members: [...]}] */
    async groups({ fresh = false } = {}) {
      if (!fresh && groupsCache && Date.now() - groupsCache.at < groupsTtlMs)
        return groupsCache.groups;
      const res = await http("GET", `/v1/groups/${enc}`);
      const data = await res.json();
      const groups = Array.isArray(data) ? data : [];
      groupsCache = { at: Date.now(), groups };
      return groups;
    },
    /** the external id `/v2/send` wants for an internal id the socket gave;
     * an unknown group falls back to the internal id (the fork's rule) */
    async externalGroupId(internalId) {
      const find = (gs) => gs.find((g) => g?.internal_id === internalId)?.id ?? null;
      let id = find(await this.groups());
      if (!id) id = find(await this.groups({ fresh: true }));
      return id ?? internalId;
    },
    /** @returns {Promise<Buffer>} */
    async attachment(id) {
      const res = await http("GET", `/v1/attachments/${encodeURIComponent(id)}`);
      return Buffer.from(await res.arrayBuffer());
    },
    /** this account's own uuid, or null when the endpoint has no answer */
    async selfUuid() {
      try {
        const res = await http("GET", `/v1/identities/${enc}`);
        const list = await res.json();
        const self = (Array.isArray(list) ? list : []).find((i) => i?.number === number);
        return typeof self?.uuid === "string" ? self.uuid.toLowerCase() : null;
      } catch (e) {
        log(`own uuid not discoverable (${e.message}) — self is known by number only`);
        return null;
      }
    },
  };
}

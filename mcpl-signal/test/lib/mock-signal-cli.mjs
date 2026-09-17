// @ts-check
/* mcpl-signal/test/lib/mock-signal-cli.mjs — enough of signal-cli-rest-api's
 * json-rpc mode for the tests, in-process, no dependency: an HTTP server
 * that records `POST /v2/send`, `PUT|DELETE /v1/typing-indicator/:n`,
 * `POST|DELETE /v1/reactions/:n`, serves `GET /v1/groups/:n`,
 * `GET /v1/identities/:n`, `GET /v1/attachments/:id`, and upgrades
 * `GET /v1/receive/:n` to a WebSocket on which `emit(envelope)` pushes
 * one JSON envelope per text frame (RFC 6455 hand-framed: server→client
 * frames are unmasked; the client's masked close/ping frames are
 * answered). Every fixture number is a 555 number; none is real. Every
 * `/v2/send` body is also shape-checked as it arrives (`state.violations`
 * — empty is clean): no raw `<@id>` token in the text, no mention entry
 * whose `author` is neither a uuid nor a number. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** one unmasked text frame */
function textFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) head = Buffer.from([0x81, 126, n >> 8, n & 0xff]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** parse as many complete client frames as `buf` holds; returns the rest */
function readFrames(buf, onFrame) {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    onFrame(b0 & 0x0f, payload);
    off = p + len;
  }
  return buf.subarray(off);
}

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_SHAPE_RE = /^\+?[0-9]{7,15}$/;

/** the shape a real `/v2/send` body must hold: no raw `<@id>` outbound
 * token ever reaches `message` text, and every `mentions[]` entry is
 * {start: non-negative int, length: 1, author: a uuid or a phone number}
 * — never anything else. Returns issue strings, empty when clean.
 * @param {any} body @returns {string[]} */
function sendBodyIssues(body) {
  const issues = [];
  if (typeof body?.message === "string" && /<@/.test(body.message)) {
    issues.push(`raw mention token reached the message text: ${JSON.stringify(body.message)}`);
  }
  for (const m of Array.isArray(body?.mentions) ? body.mentions : []) {
    if (!Number.isInteger(m?.start) || m.start < 0) issues.push(`mention.start invalid: ${JSON.stringify(m)}`);
    if (m?.length !== 1) issues.push(`mention.length is not 1: ${JSON.stringify(m)}`);
    const author = String(m?.author ?? "");
    if (!UUID_SHAPE_RE.test(author) && !NUMBER_SHAPE_RE.test(author))
      issues.push(`mention.author is neither a uuid nor a number: ${JSON.stringify(m)}`);
  }
  return issues;
}

/** @param {{groups?: any[], identities?: any[], attachments?: Record<string, Buffer>,
 *   sendStatus?: number}} [opts] */
export async function createMockSignalCli(opts = {}) {
  const state = {
    groups: opts.groups ?? [],
    identities: opts.identities ?? [],
    attachments: opts.attachments ?? {},
    sendStatus: opts.sendStatus ?? 201,
    /** @type {any[]} */ sent: [],
    /** @type {any[]} */ typing: [],
    /** @type {any[]} */ reactions: [],
    /** @type {string[]} */ receivePaths: [],
    /** every `/v2/send` body's shape issues, in send order — empty is clean */
    /** @type {string[]} */ violations: [],
    connections: 0,
    /** @type {Set<import("node:net").Socket>} */ sockets: new Set(),
  };
  let sendSeq = 1_700_000_000_000;

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(s ? JSON.parse(s) : null);
        } catch {
          resolve(null);
        }
      });
    });
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    if (req.method === "POST" && path === "/v2/send") {
      const body = await readBody(req);
      state.sent.push(body);
      state.violations.push(...sendBodyIssues(body));
      if (state.sendStatus >= 400) return json(res, state.sendStatus, { error: "scripted" });
      return json(res, 201, { timestamp: String(sendSeq++) });
    }
    if (path.startsWith("/v1/typing-indicator/")) {
      state.typing.push({ method: req.method, body: await readBody(req) });
      return json(res, 204);
    }
    if (path.startsWith("/v1/reactions/")) {
      state.reactions.push({ method: req.method, body: await readBody(req) });
      return json(res, 204);
    }
    if (req.method === "GET" && path.startsWith("/v1/groups/")) return json(res, 200, state.groups);
    if (req.method === "GET" && path.startsWith("/v1/identities/"))
      return json(res, 200, state.identities);
    if (req.method === "GET" && path.startsWith("/v1/attachments/")) {
      const id = decodeURIComponent(path.slice("/v1/attachments/".length));
      const bytes = state.attachments[id];
      if (!bytes) return json(res, 404, { error: "no such attachment" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(bytes);
    }
    if (req.method === "GET" && path === "/v1/about") return json(res, 200, { version: "mock" });
    json(res, 404, { error: `mock: no route for ${req.method} ${path}` });
  });

  server.on("upgrade", (req, socket) => {
    const path = new URL(req.url ?? "/", "http://mock").pathname;
    const key = req.headers["sec-websocket-key"];
    if (!path.startsWith("/v1/receive/") || typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    state.receivePaths.push(path);
    state.connections += 1;
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    state.sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = readFrames(Buffer.concat([buf, chunk]), (opcode, payload) => {
        if (opcode === 0x8) {
          try {
            socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
          } catch {
            /* gone */
          }
          socket.end();
        } else if (opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        }
      });
    });
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("error", () => state.sockets.delete(socket));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const port = address.port;

  return {
    state,
    port,
    url: `http://127.0.0.1:${port}`,
    /** push one envelope to every receive socket */
    emit(envelope) {
      const frame = textFrame(JSON.stringify(envelope));
      for (const s of state.sockets) s.write(frame);
      return state.sockets.size;
    },
    /** drop every receive socket (a signal-cli restart) */
    dropSockets() {
      for (const s of state.sockets) s.destroy();
      state.sockets.clear();
    },
    async close() {
      this.dropSockets();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ---------- envelope factories (555 numbers only) ---------- */
export const NUMBERS = {
  bot: "+15550000001",
  alice: "+15550000002",
  phoneOnly: "+15550000003",
};
export const UUIDS = {
  bot: "aaaaaaaa-0000-4000-8000-000000000001",
  alice: "aaaaaaaa-0000-4000-8000-000000000002",
  carol: "aaaaaaaa-0000-4000-8000-000000000003",
};
export const GROUP = {
  internal_id: "Z3JvdXAtaW50ZXJuYWw=",
  id: "group.ZXh0ZXJuYWwtaWQ=",
  name: "the porch",
};

let ts = 1_725_000_000_000;
export const nextTs = () => ++ts;

/** a dataMessage envelope from alice (uuid + number + name) */
export function dataMessage({
  text = "",
  group = null,
  from = "alice",
  mentions = [],
  quote = null,
  attachments = [],
  timestamp = nextTs(),
} = {}) {
  const who =
    from === "phoneOnly"
      ? { sourceNumber: NUMBERS.phoneOnly, source: NUMBERS.phoneOnly }
      : {
          sourceNumber: NUMBERS[from] ?? null,
          sourceUuid: UUIDS[from],
          sourceName: from,
          source: NUMBERS[from] ?? UUIDS[from],
        };
  return {
    envelope: {
      ...who,
      sourceDevice: 1,
      timestamp,
      dataMessage: {
        timestamp,
        message: text,
        expiresInSeconds: 0,
        viewOnce: false,
        ...(group
          ? { groupInfo: { groupId: group.internal_id, groupName: group.name, type: "DELIVER" } }
          : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(quote ? { quote } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
    },
    account: NUMBERS.bot,
  };
}

/** a mention of `uuid` at `start` (the text must hold U+FFFC there) */
export const mention = (uuid, start) => ({ uuid, start, length: 1, name: null, number: null });

export function reactionEnvelope({
  emoji,
  targetAuthorUuid,
  targetTimestamp,
  group = null,
  from = "alice",
  remove = false,
}) {
  const e = dataMessage({ group, from });
  e.envelope.dataMessage.reaction = {
    emoji,
    targetAuthor: targetAuthorUuid,
    targetAuthorUuid,
    targetSentTimestamp: targetTimestamp,
    isRemove: remove,
  };
  return e;
}

/** the account's own other device sending into a group or DM */
export function syncSent({ text, group = null, toUuid = null, timestamp = nextTs() }) {
  return {
    envelope: {
      source: NUMBERS.bot,
      sourceNumber: NUMBERS.bot,
      sourceUuid: UUIDS.bot,
      sourceDevice: 2,
      timestamp,
      syncMessage: {
        sentMessage: {
          timestamp,
          message: text,
          ...(group
            ? { groupInfo: { groupId: group.internal_id, groupName: group.name, type: "DELIVER" } }
            : { destination: toUuid, destinationUuid: toUuid }),
        },
      },
    },
    account: NUMBERS.bot,
  };
}

/** an editMessage envelope: signal-cli-rest-api's json-rpc grammar for an
 * edit is `envelope.editMessage = {targetSentTimestamp, dataMessage}` — the
 * new content, shaped exactly like an ordinary dataMessage, naming the
 * timestamp of the message it replaces. */
export function editMessageEnvelope({
  text = "",
  group = null,
  from = "alice",
  targetTimestamp,
  mentions = [],
  timestamp = nextTs(),
} = {}) {
  const base = dataMessage({ text, group, from, mentions, timestamp });
  const dataMessageBody = base.envelope.dataMessage;
  return {
    envelope: {
      ...base.envelope,
      dataMessage: undefined,
      editMessage: { targetSentTimestamp: targetTimestamp, dataMessage: dataMessageBody },
    },
    account: NUMBERS.bot,
  };
}

/** a remoteDelete envelope: `dataMessage.remoteDelete = {timestamp}` names
 * the timestamp of the message being deleted; the delete control message
 * itself carries no text. */
export function remoteDeleteEnvelope({
  group = null,
  from = "alice",
  targetTimestamp,
  timestamp = nextTs(),
} = {}) {
  const base = dataMessage({ text: "", group, from, timestamp });
  base.envelope.dataMessage.remoteDelete = { timestamp: targetTimestamp };
  return base;
}

export const typingEnvelope = () => ({
  envelope: {
    sourceUuid: UUIDS.alice,
    timestamp: nextTs(),
    typingMessage: { action: "STARTED", timestamp: nextTs() },
  },
  account: NUMBERS.bot,
});

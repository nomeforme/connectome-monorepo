// @ts-check
/* harness/src/mcpl/wire.mjs — the JSON-RPC wire to ONE MCPL server, and
 * nothing platform-shaped: spawn a stdio child (or wrap any stream pair),
 * frame lines, correlate request ids, answer the server's own Requests,
 * time out, notice the child leaving. The framing/type layer is
 * `@animalabs/mcpl-core` (pinned exact, MIT, zero deps — "pin, wrap,
 * never vendor"); this module is the ONLY file that imports it, so the
 * house stays on the vocabulary the servers were written against while
 * nothing else learns the library's name (docs/research/mcpl.md §2.1).
 *
 * Spec facts held here (repos/mcpl/SPEC.md): a Request the host does not
 * support gets a JSON-RPC ERROR, never silence (§6.6 — "never leave an
 * `id` unanswered"); tag closure is applied by the host from the spec, not
 * from the producer's ontology (§16.3); a manifest revision is a content
 * digest (§17.2, RFC-003). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  McplConnection,
  advertisedCapabilitiesFromInitialize,
  expandTags,
  manifestDigest,
  method,
} from "@animalabs/mcpl-core";

/** the MCPL method names, re-exported so host/seat spell none themselves */
export const METHOD = method;

/** JSON-RPC error codes the wire answers with (SPEC App. A / §14.6) */
export const RPC = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TIMEOUT: -32000,
  FEATURE_SET_NOT_ENABLED: -32001,
  CAPABILITY_DENIED: -32002,
  UNKNOWN_CHANNEL: -32023,
};

/** the spec's own closure (§16.3), applied without consulting the server's
 * ontology: mention/reply ⇒ addressed; dm ⇒ addressed AND private (the
 * library's CHAT_TAG_IMPLIES lacks the private edge — added here, the
 * study §2.1's noted drift); then an event carrying both `addressed` and
 * `ambient` drops `ambient`.
 * @param {unknown} tags @returns {string[]} */
export function expandTagClosure(tags) {
  const input = Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : [];
  const out = new Set(
    expandTags(input, {
      "chat:mention": ["chat:addressed"],
      "chat:reply": ["chat:addressed"],
      "chat:dm": ["chat:addressed", "chat:private"],
    }),
  );
  if (out.has("chat:addressed")) out.delete("chat:ambient");
  return [...out];
}

/** the capability paths an `initialize` result ADVERTISES (boolean
 * shorthand expanded to leaves; `tools` from the outer MCP `capabilities.
 * tools` only) — an input to the host's grant computation, never an
 * authorization (§5.4). A 0.4 server's `channels: true` reads as every
 * channel leaf, which is why the host intersects with its own allowlist.
 * @param {unknown} capabilities @returns {Set<string>} */
export function advertisedPaths(capabilities) {
  try {
    return new Set(advertisedCapabilitiesFromInitialize(/** @type {any} */ (capabilities)));
  } catch {
    return new Set();
  }
}

/** RFC-003's digest over the manifest (the whole `experimental.mcpl`
 * object minus `revision`); a manifest the library refuses to canonicalize
 * (an identifier outside its charset — a 0.4 server's legacy array form
 * can carry one) falls back to a plain sha256 of its JSON, prefixed so the
 * two can never be mistaken for each other. Equality is the only operation
 * a revision supports either way.
 * @param {unknown} manifest @returns {string} */
export function manifestRevision(manifest) {
  const m = manifest && typeof manifest === "object" ? { ...manifest } : {};
  delete m.revision;
  try {
    return manifestDigest(m);
  } catch {
    return `json-sha256:${createHash("sha256").update(JSON.stringify(m)).digest("base64url")}`;
  }
}

/**
 * @typedef {Object} Wire
 * @property {(method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>} request
 * @property {(method: string, params?: unknown) => void} notify
 * @property {(handler: (method: string, params: unknown) => Promise<unknown>|unknown) => void} onRequest
 * @property {(handler: (method: string, params: unknown) => void) => void} onNotification
 * @property {(cb: (info: {code: number|null, signal: string|null}) => void) => void} onClose
 * @property {() => boolean} isClosed
 * @property {() => void} close
 * @property {import("node:child_process").ChildProcess|null} child
 */

/** wrap an already-open stream pair (the child's stdout to read, its stdin
 * to write — or a PassThrough pair in a test). One request handler, one
 * notification handler: the host loop is the consumer, not this file.
 * @param {{readable: import("node:stream").Readable, writable: import("node:stream").Writable,
 *   requestTimeoutMs?: number, child?: import("node:child_process").ChildProcess|null,
 *   log?: (line: string) => void}} opts
 * @returns {Wire} */
export function openWire({ readable, writable, requestTimeoutMs = 30_000, child = null, log }) {
  const conn = McplConnection.fromStreams(readable, writable);
  conn.requestTimeout = requestTimeoutMs;
  /** @type {((method: string, params: unknown) => Promise<unknown>|unknown)|null} */
  let requestHandler = null;
  /** @type {((method: string, params: unknown) => void)|null} */
  let notificationHandler = null;
  /** @type {Array<(info: {code: number|null, signal: string|null}) => void>} */
  const closeCbs = [];
  let closedInfo = /** @type {{code: number|null, signal: string|null}|null} */ (null);
  const emitClose = (info) => {
    if (closedInfo) return;
    closedInfo = info;
    for (const cb of closeCbs.splice(0)) {
      try {
        cb(info);
      } catch (e) {
        log?.(`close handler threw: ${e.message}`);
      }
    }
  };

  conn.on("request", (req) => {
    const id = req.id;
    const respond = async () => {
      if (!requestHandler) {
        conn.sendError(id, RPC.METHOD_NOT_FOUND, `no handler for ${req.method}`);
        return;
      }
      try {
        const result = await requestHandler(req.method, req.params);
        if (result === undefined) {
          conn.sendError(id, RPC.METHOD_NOT_FOUND, `${req.method} is not supported by this host`);
        } else if (result && typeof result === "object" && "__rpcError" in result) {
          const e = /** @type {{__rpcError: {code: number, message: string, data?: unknown}}} */ (
            result
          ).__rpcError;
          conn.sendError(id, e.code, e.message, e.data);
        } else {
          conn.sendResponse(id, result);
        }
      } catch (e) {
        conn.sendError(id, RPC.INTERNAL, e?.message ?? String(e));
      }
    };
    void respond();
  });
  conn.on("notification", (n) => {
    try {
      notificationHandler?.(n.method, n.params);
    } catch (e) {
      log?.(`notification handler threw on ${n.method}: ${e.message}`);
    }
  });
  // a non-JSON stdout line (a server's own stray log line, observed from
  // discord-mcpl) fires this same event once per line — logged once per
  // connection at debug level, never as a repeating error; any other wire
  // error still logs in full every time.
  let malformedWarned = false;
  conn.on("error", (e) => {
    if (/^Malformed JSON-RPC message:/.test(e.message)) {
      if (!malformedWarned) {
        malformedWarned = true;
        log?.(
          `debug: a non-JSON line arrived on stdout, ignored (further ones on this connection are too): ${e.message}`,
        );
      }
      return;
    }
    log?.(`wire error: ${e.message}`);
  });
  conn.on("close", () => {
    if (!child) emitClose({ code: null, signal: null });
  });
  if (child) {
    child.on("exit", (code, signal) => {
      conn.close();
      emitClose({ code, signal });
    });
    child.on("error", (e) => {
      log?.(`child error: ${e.message}`);
      conn.close();
      emitClose({ code: null, signal: null });
    });
  }

  return {
    child,
    request: (m, params, timeoutMs) => conn.sendRequest(m, params, timeoutMs),
    notify: (m, params) => conn.sendNotification(m, params),
    onRequest: (h) => {
      requestHandler = h;
    },
    onNotification: (h) => {
      notificationHandler = h;
    },
    onClose: (cb) => {
      if (closedInfo) cb(closedInfo);
      else closeCbs.push(cb);
    },
    isClosed: () => conn.isClosed,
    close: () => {
      conn.close();
      if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
    },
  };
}

/** the shape an unsupported-method answer takes from a request handler:
 * a JSON-RPC error on the wire instead of a hung caller (§6.6). */
export function rpcError(code, message, data) {
  return { __rpcError: data === undefined ? { code, message } : { code, message, data } };
}

/** the environment a child gets: a few process-wide basics plus ONLY the
 * variables `names` lists, read at spawn time from this process's env.
 * Values never live in config — the keeper's server file names variables
 * (`DISCORD_TOKEN`), harness/.env holds them (pii-discipline tier 0).
 * @param {string[]|undefined} names @param {NodeJS.ProcessEnv} [from] */
export function childEnv(names, from = process.env) {
  const out = /** @type {Record<string, string>} */ ({});
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR", "NODE_OPTIONS"])
    if (typeof from[k] === "string") out[k] = from[k];
  for (const k of Array.isArray(names) ? names : []) {
    if (typeof k !== "string") continue;
    const [child, house = child] = k.split("="); // CHILD=HOUSE renames on the way in
    if (typeof from[house] === "string") out[child] = from[house];
  }
  return out;
}

/** spawn a stdio MCPL server and wire it: stdout read, stdin written,
 * stderr line-forwarded to `log` (never inherited raw — a server's stderr
 * is the house's log, tagged). `env` is a list of NAMES to pass through.
 * @param {{command: string, args?: string[], env?: string[], cwd?: string,
 *   requestTimeoutMs?: number, log?: (line: string) => void}} opts
 * @returns {Wire} */
export function spawnWire({ command, args = [], env, cwd, requestTimeoutMs, log }) {
  const child = spawn(command, args, {
    cwd,
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.stderr) {
    let buf = "";
    child.stderr.on("data", (b) => {
      buf += b.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) log?.(`stderr: ${l}`);
    });
  }
  if (!child.stdout || !child.stdin) throw new Error("spawnWire: child has no stdio pipes");
  return openWire({ readable: child.stdout, writable: child.stdin, requestTimeoutMs, child, log });
}

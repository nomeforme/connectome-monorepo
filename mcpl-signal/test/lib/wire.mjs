// @ts-check
/* mcpl-signal/test/lib/wire.mjs — a minimal JSON-RPC wire for these tests
 * only, built directly on @animalabs/mcpl-core's McplConnection. Not part
 * of the server's own runtime (the server speaks the same protocol over
 * its own McplConnection in src/server.mjs) — this is the HOST side a real
 * host would implement, reduced to just what the tests drive:
 *   - one inbound-request handler (channels/register, channels/incoming,
 *     push/event, channels/changed all arrive as host-bound requests),
 *   - request()/notify() out.
 * `openWire` wraps an existing stream pair (server.test.mjs's PassThrough
 * pair); `spawnWire` spawns a child process and wires its stdio, forwarding
 * only the named env vars (mirroring how a real host allowlists a child's
 * environment). */
import { spawn } from "node:child_process";
import { McplConnection } from "@animalabs/mcpl-core";

function wrap(conn, { requestTimeoutMs = 30_000 } = {}) {
  conn.requestTimeout = requestTimeoutMs;
  let handler = null;
  let notified = null;
  conn.on("request", (req) => {
    Promise.resolve()
      .then(() => (handler ? handler(req.method, req.params) : undefined))
      .then(
        (result) => conn.sendResponse(req.id, result),
        (e) =>
          conn.sendError(
            req.id,
            typeof e?.code === "number" ? e.code : -32603,
            e?.message ?? String(e),
            e?.data,
          ),
      );
  });
  conn.on("notification", (n) => notified?.(n.method, n.params));
  return {
    request: (method, params) => conn.sendRequest(method, params),
    notify: (method, params) => conn.sendNotification(method, params),
    /** @param {(method: string, params: any) => Promise<any>|any} fn */
    onRequest: (fn) => {
      handler = fn;
    },
    /** @param {(method: string, params: any) => void} fn a server->host notification */
    onNotification: (fn) => {
      notified = fn;
    },
    onClose: (fn) => conn.on("close", fn),
    close: () => conn.close(),
  };
}

/** @param {{readable: import("node:stream").Readable, writable: import("node:stream").Writable,
 *   requestTimeoutMs?: number}} opts */
export function openWire({ readable, writable, requestTimeoutMs }) {
  return wrap(McplConnection.fromStreams(readable, writable), { requestTimeoutMs });
}

/** @param {{command: string, args: string[], env?: string[], cwd?: string,
 *   requestTimeoutMs?: number}} opts */
export function spawnWire({ command, args, env = [], cwd, requestTimeoutMs }) {
  const childEnv = {};
  for (const k of env) if (process.env[k] !== undefined) childEnv[k] = process.env[k];
  if (process.env.PATH) childEnv.PATH = process.env.PATH;
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const wire = wrap(McplConnection.fromStreams(child.stdout, child.stdin), { requestTimeoutMs });
  return { ...wire, child };
}

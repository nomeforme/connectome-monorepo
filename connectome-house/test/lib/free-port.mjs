// @ts-check
/* harness/test/lib/free-port.mjs — one free-port probe, shared by every test
 * file that used to hardcode its own fixed port (17341-17350 and friends).
 * Lifted out of resident-smoke.mjs's own freePort() (review C9): two
 * concurrent `npm test` runs in different checkouts/worktrees must never
 * see EADDRINUSE or a stale-serve 409 from each other, and a fixed literal
 * is exactly what made that possible.
 *
 * freePort() binds a `net` server on port 0 (the OS assigns a genuinely
 * free ephemeral port), reads the assignment back, closes, and hands the
 * number to the caller — a race remains between this close and the real
 * bind the caller does moments later, but it's a local, single-host,
 * microseconds-wide window, the same one resident-smoke.mjs already
 * accepted.
 *
 * freePorts(n) needs more care than "call freePort() n times": two
 * sequential probes each open-then-close before returning, so nothing
 * stops the OS handing the second call the very port the first one just
 * released. freePorts binds all n servers AT ONCE (so the addresses are
 * guaranteed distinct while all n are simultaneously held), reads every
 * port, THEN closes them all together.
 */
import { createServer } from "node:net";

/** @returns {Promise<number>} a free TCP port on 127.0.0.1, probed and released. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close(() => {
        if (port == null) reject(new Error("freePort: server address() returned no port"));
        else resolve(port);
      });
    });
  });
}

/**
 * @param {number} n
 * @returns {Promise<number[]>} n distinct free ports, in no particular order guarantee.
 */
export function freePorts(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error("freePorts: n must be a positive integer");
  return new Promise((resolve, reject) => {
    const servers = [];
    const ports = new Array(n);
    let remaining = n;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      for (const s of servers) s.close();
      reject(err);
    };
    for (let i = 0; i < n; i++) {
      const srv = createServer();
      servers.push(srv);
      srv.on("error", fail);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        ports[i] = typeof address === "object" && address ? address.port : null;
        remaining -= 1;
        if (remaining === 0 && !settled) {
          settled = true;
          Promise.all(servers.map((s) => new Promise((res) => s.close(res)))).then(() => resolve(ports));
        }
      });
    }
  });
}

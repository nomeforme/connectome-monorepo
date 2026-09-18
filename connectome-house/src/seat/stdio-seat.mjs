// @ts-check
/* connectome-house/src/seat/stdio-seat.mjs — wraps a spawned child
 * process as a Seat: one typed interface (send/isLive/onTokens/onLog/
 * onMessage/onExit/kill) over a one-child-process-per-tree stdio
 * transport, so callers stop touching a raw child process directly.
 * `onMessage` is a stub here (no structured-message transport yet) —
 * this is the STDIO transport specifically; the being's-turn socket
 * transport docs/harness-port/03-house-design.md §2.3 recommends is a
 * separate implementation of the same `Seat` shape (`protocol.mjs`'s
 * senders only need `rec.seat.send`).
 * `runIds` tracks every branch this seat carries (root + every fork), so
 * a seat's own cleanup (protocol.mjs's retireSeatBranch) can wait for the
 * LAST one to close rather than firing per-branch. */

/** @typedef {{
 *   id: string,
 *   transport: "stdio",
 *   runIds: Set<string>,
 *   send: (line: string) => boolean,
 *   isLive: () => boolean,
 *   onTokens: (fn: (branch: string, text: string) => void) => void,
 *   onLog: (fn: (text: string) => void) => void,
 *   onMessage: (fn: (msg: object) => void) => void,
 *   onExit: (fn: (code: number|null) => void) => void,
 *   kill: (signal?: string) => void,
 *   raw: import("node:child_process").ChildProcess,
 * }} Seat */

/** wrap a freshly spawned child as a Seat; `id` seeds `runIds` and is the
 * stdout demux's starting branch.
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} id
 * @returns {Seat} */
export function wrapStdioSeat(child, id) {
  child.stdin.on("error", (e) => console.error(`[seat ${id}] stdin write failed: ${e.message}`));
  const tokenFns = [];
  const logFns = [];
  const exitFns = [];

  // the shared child's stdout carries \x01{"stdoutBranch":id}\n markers
  // naming which branch the following tokens belong to; a partial marker
  // waits for its newline.
  const stdoutState = { branch: id, buf: "" };
  child.stdout.on("data", (b) => {
    stdoutState.buf += b.toString();
    const segs = [];
    for (;;) {
      const at = stdoutState.buf.indexOf("\x01");
      if (at === -1) {
        if (stdoutState.buf) segs.push({ branch: stdoutState.branch, text: stdoutState.buf });
        stdoutState.buf = "";
        break;
      }
      if (at > 0) {
        segs.push({ branch: stdoutState.branch, text: stdoutState.buf.slice(0, at) });
        stdoutState.buf = stdoutState.buf.slice(at);
      }
      const nl = stdoutState.buf.indexOf("\n");
      if (nl === -1) break; // partial marker — wait for the rest
      const line = stdoutState.buf.slice(1, nl);
      stdoutState.buf = stdoutState.buf.slice(nl + 1);
      let marked = false;
      try {
        const m = JSON.parse(line);
        if (typeof m.stdoutBranch === "string") {
          stdoutState.branch = m.stdoutBranch;
          marked = true;
        }
      } catch {
        /* not a marker */
      }
      if (!marked) segs.push({ branch: stdoutState.branch, text: `\x01${line}\n` });
    }
    for (const seg of segs) {
      if (!seg.text) continue;
      for (const fn of tokenFns) fn(seg.branch, seg.text);
    }
  });
  child.stderr.on("data", (b) => {
    const text = b.toString();
    for (const fn of logFns) fn(text);
  });
  child.on("exit", (code) => {
    for (const fn of exitFns) fn(code);
  });

  return {
    id,
    transport: "stdio",
    runIds: new Set([id]),
    send(line) {
      // false when not live, never throws — the same non-fatal EPIPE
      // posture the direct child.stdin.write calls got from the stdin
      // "error" listener above.
      if (child.exitCode != null || child.signalCode != null || child.killed) return false;
      // room-turn.mjs sends structured objects (`rec.seat.send({type:
      // "turn.begin", ...})`); a plain child.stdin.write(object) would
      // coerce to the literal string "[object Object]" — encode a
      // non-string as \x01{json}\n, the SAME wire format walk-stdin-
      // verbs.mjs's own StdioSeat already reads on the walker side
      // (its own header names this exact gap).
      const data = typeof line === "string" ? line : `\x01${JSON.stringify(line)}\n`;
      try {
        return child.stdin.write(data);
      } catch (e) {
        console.error(`[seat ${id}] stdin write failed: ${e.message}`);
        return false;
      }
    },
    isLive() {
      return child.exitCode == null && child.signalCode == null && !child.killed;
    },
    onTokens(fn) {
      tokenFns.push(fn);
    },
    onLog(fn) {
      logFns.push(fn);
    },
    onMessage(_fn) {
      /* no transport carries structured messages yet — a future one lands here */
    },
    onExit(fn) {
      exitFns.push(fn);
    },
    kill(signal) {
      child.kill(signal);
    },
    raw: child,
  };
}

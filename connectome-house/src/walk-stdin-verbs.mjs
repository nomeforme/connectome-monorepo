// @ts-check
/* connectome-house/src/walk-stdin-verbs.mjs — the walker's STDIO
 * transport: reads `\x01{...}\n` control lines from stdin (seat/
 * protocol.mjs's own `verb()` wire format, keyed by `kind` — the format
 * stdio-seat.mjs's house side still speaks) and writes turn events back
 * over stdout the same way, normalizing both that older `kind`-keyed
 * shape and the newer seat-protocol `type`-keyed shape into ONE
 * `on(type, fn)` interface — the same shape @connectome/seat-client's
 * SeatClient exposes, so walker.mjs drives either transport identically.
 *
 * FIXED (harness-port W1-R, 2026-09-18): room-turn.mjs — the only
 * house-side caller that actually drives a real turn — sends STRUCTURED
 * OBJECTS directly (`rec.seat.send({type: "turn.begin", ...})`); stdio-
 * seat.mjs's own `send()` now encodes a non-string argument as this same
 * `\x01{json}\n` wire format before writing it to the child's stdin
 * (previously it coerced to the literal string "[object Object]" instead).
 * This transport is still untested against a live room-turn.mjs turn end
 * to end (this round's own e2e uses the socket transport only, matching
 * what room-turn.mjs's own tests already drive) — the WIRE FORMAT itself
 * is what's fixed and unit-tested (test/seat-stdio.test.mjs). */
import { createInterface } from "node:readline";

const encode = (msg) => `\x01${JSON.stringify(msg)}\n`;

/** normalize a `kind`-keyed stdio verb OR a `type`-keyed wire message into
 * one `{type, ...fields}` shape this module's listeners key on. */
function normalize(msg) {
  if (typeof msg.type === "string") return msg;
  if (msg.kind === "interrupt") return { type: "interrupt", by: msg.by };
  if (msg.kind === "close") return { type: "close", mode: msg.mode === "rest" ? "rest" : "seal" };
  if (msg.kind === "participant")
    return { type: "participant", action: msg.action, handle: msg.handle, participantKind: msg.participant_kind };
  if (msg.kind === "house") return { type: "house.frame", frame: msg.frame };
  if (typeof msg.text === "string") return { type: "line", by: msg.by, text: msg.text, branch: msg.branch };
  return msg;
}

export class StdioSeat {
  constructor() {
    /** @type {Map<string, Array<(msg: any) => void>>} */
    this.handlers = new Map();
    this.live = true;
  }
  connect() {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (raw) => {
      if (!raw.startsWith("\x01")) return; // ordinary stdin noise, not a verb
      let msg;
      try {
        msg = JSON.parse(raw.slice(1));
      } catch {
        return;
      }
      this._dispatch(normalize(msg));
    });
    process.stdin.on("end", () => {
      this.live = false;
      this._dispatch({ type: "__close__" });
    });
    return Promise.resolve(this);
  }
  _dispatch(msg) {
    for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
    for (const fn of this.handlers.get("*") ?? []) fn(msg);
  }
  /** @param {string} type @param {(msg: any) => void} fn */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => {};
  }
  /** @param {Record<string, unknown>} msg */
  send(msg) {
    try {
      return process.stdout.write(encode(msg));
    } catch {
      return false;
    }
  }
  isLive() {
    return this.live;
  }
  close() {
    this.live = false;
  }
}

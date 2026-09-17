// @ts-check
/* connectome-seat-protocol/src/codec.mjs — a newline-delimited-JSON codec
 * for the seat message set: one validated message per line, either
 * direction. `NdjsonReader` buffers partial lines across chunk boundaries
 * (a socket's `data` event has no notion of "one message per event") and
 * reports a malformed line through `onError` without ever throwing out of
 * `push()` or otherwise touching the connection — a bad message is the
 * sender's mistake, not a reason to drop the whole seat. */
import { validateMessage, SeatProtocolError } from "./validators.mjs";

/** @param {Record<string, unknown>} message
 * @returns {string} one line, newline-terminated */
export function encodeMessage(message) {
  validateMessage(message);
  return `${JSON.stringify(message)}\n`;
}

/** @param {string} line one line, without its trailing newline
 * @returns {Record<string, unknown>} */
export function decodeLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new SeatProtocolError(`malformed JSON line: ${e instanceof Error ? e.message : e}`);
  }
  return validateMessage(parsed);
}

export class NdjsonReader {
  /** @param {{onMessage: (msg: Record<string, unknown>) => void, onError?: (e: SeatProtocolError) => void}} opts */
  constructor({ onMessage, onError }) {
    this.buf = "";
    this.onMessage = onMessage;
    this.onError = onError ?? (() => {});
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        this.onMessage(decodeLine(line));
      } catch (e) {
        this.onError(e instanceof SeatProtocolError ? e : new SeatProtocolError(String(e instanceof Error ? e.message : e)));
      }
    }
  }
}

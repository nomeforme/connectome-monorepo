// @ts-check
/* connectome-house/src/frames-io.mjs — the record's READ layer: tails a
 * frames.jsonl by byte offset (`tailFrames`, `lastFrameInfo`), appends a
 * server-side house frame to a NON-live room (`appendHouseFrame`), and
 * schema-checks a frame before it's handed to a caller (`checkFrame` —
 * fail-open: warns on a mismatch, always forwards the frame unchanged,
 * never the cause of a dropped update).
 *
 * Ported from a private deployment's serve-runs.mjs (2026-09-17): this
 * file carries only its frame-file-IO functions — that source also owned
 * an HTTP run-listing/citation/leaf-hit layer (product/UI concerns, out
 * of scope for this port).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import Ajv from "ajv";
import { Frame } from "./frame-schema.mjs";
import { frameText } from "./trace.mjs";

const ajv = new Ajv({ strict: false });
const validateFrame = ajv.compile(Frame);

/** Serve-time derived view: a message frame past trace.mjs's inline
 * threshold carries only a 400-char `preview` on disk — resolve the full
 * text at every hand-off and attach it as `inline`. frames.jsonl itself
 * stays untouched. */
export function hydrateSpeech(frame, runDir) {
  if (
    (frame?.type === "message" || frame?.type === "speech") &&
    typeof frame.inline !== "string" &&
    (frame.blob || frame.file)
  ) {
    const text = frameText(frame, runDir);
    if (text) return { ...frame, inline: text };
  }
  return frame;
}

/** Fail-open: warn on a schema mismatch, but ALWAYS forward the frame
 * unchanged — never the cause of a dropped or blanked-out update.
 * @param {unknown} frame @returns {unknown} */
export function checkFrame(frame) {
  if (!validateFrame(frame)) {
    console.error(
      `[frames-io] frame didn't match Frame schema (forwarding anyway): ` +
        ajv.errorsText(validateFrame.errors, { dataVar: "frame" }),
    );
  }
  return frame;
}

/** tail `path` from byte `offset`, parsing whole JSONL lines into frame
 * objects; returns the parsed frames and the offset to resume from next
 * time. Optimistic-then-rewind-on-partial-line: a line still being written
 * mid-append rewinds the offset back to its own start rather than dropping
 * or half-parsing it. @param {string} path @param {number} offset */
export function tailFrames(path, offset) {
  if (!existsSync(path)) return { frames: [], offset };
  const size = statSync(path).size;
  if (size <= offset) return { frames: [], offset };
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  let next = size;
  const frames = [];
  for (const line of buf.toString().split("\n").filter(Boolean)) {
    try {
      frames.push(JSON.parse(line));
    } catch {
      /* partial line: rewind */ next -= Buffer.byteLength(line) + 1;
      break;
    }
  }
  return { frames, offset: next };
}

/** the last parseable frame's {type, seq} from a frames.jsonl TAIL read —
 * boot reconciliation and every lifecycle op that needs a fresh branch's
 * registration watermark read only the last 8KB. */
export function lastFrameInfo(path) {
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - 8192);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    const lines = buf.toString().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const f = JSON.parse(lines[i]);
        if (f && typeof f.type === "string") return { type: f.type, seq: f.seq ?? 0 };
      } catch {
        /* partial/truncated line — keep walking back */
      }
    }
  } catch {}
  return { type: null, seq: 0 };
}

/** the seq a server-side house frame appended to a NON-live run takes:
 * when the last frame's own seq is a plain integer, the floor plus a half
 * — never a bare `+1` (collides with a later child's own in-memory
 * counter). When the last frame is ITSELF already fractional (a house
 * frame preceded by another house frame, with no live/integer frame in
 * between — two ambient messages in a room with no seated being, say),
 * a bare `+0.5` would land exactly on the one value already used,
 * silently colliding (found 2026-09-17 wiring the being's-turn seat's own
 * multi-message room worker loop): instead, split whatever gap remains up
 * to the next integer in half again, so each consecutive house-only
 * append keeps strictly advancing — still always `< floor+1`, so it can
 * never collide with a later live child's own integer counter either. */
export function houseFrameSeq(framesPath) {
  const { seq } = lastFrameInfo(framesPath);
  const floor = Math.floor(seq);
  if (seq === floor) return floor + 0.5;
  return seq + (floor + 1 - seq) / 2;
}

/** append one house frame to a non-live run's frames.jsonl at
 * `houseFrameSeq` — one write() syscall, atomic at the OS level, so it's
 * safe beside a live seat appending concurrently. Returns the frame
 * written, or null when the run has no frames.jsonl (an honest no-append
 * rather than fabricating a room that isn't there). */
export function appendHouseFrame(framesPath, fields) {
  if (!existsSync(framesPath)) return null;
  const frame = { seq: houseFrameSeq(framesPath), t: new Date().toISOString(), ...fields };
  appendFileSync(framesPath, `${JSON.stringify(frame)}\n`);
  return frame;
}

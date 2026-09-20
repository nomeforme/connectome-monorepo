// @ts-check
/* connectome-house/src/mcpl/message-index.mjs — harness-port P-F,
 * 2026-09-17 (mission task 1; PARITY-discord.md §5's own naming of this as
 * "the single largest missing piece"): a small per-room index, platform
 * message_id -> this room's own frame `seq`, built from a room's own
 * external.jsonl (both directions) and, for inbound, frames.jsonl too.
 *
 * Outbound is direct: speak.mjs's `recordOutbound` already writes `seq`
 * alongside `message_id` on every delivered row (outbound.mjs) — no
 * correlation needed, just a read.
 *
 * Inbound has no `seq` recorded at all (serve-rooms.mjs's `roomInput` is
 * NO-TOUCH for this task — its own external.jsonl "in" row carries only
 * `platform`, `message_id`, `author`, and a `text_sha` hash, never a frame
 * seq). Both files are append-only, and `roomInput`'s own body writes the
 * external "in" row and this message's own `message` frame synchronously,
 * one right after the other, with no `await` between the two
 * `appendFileSync` calls (confirmed by reading it) — so two different
 * `roomInput` calls can never interleave their own pair of writes. That
 * means the Nth inbound "in" row and the Nth still-unclaimed `message`
 * frame matching its own `(author, text_sha)` are the same message, in
 * strict file order — a positional+content pairing, not a guess.
 *
 * harness-port 33 (docs/harness-port/33-own-speech-echo.md): an inbound "in"
 * row can ALSO carry its own `echo_of_seq` — serve-rooms.mjs's roomInput,
 * recognizing a being's own speech fanned back inbound before its outbound
 * row was recorded, writes this instead of ever appending a `message`
 * frame. Such a row resolves directly off `echo_of_seq`, never off the
 * positional `message`-frame walk below (there is no frame to find — that
 * walk is only for genuine inbound messages). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} text @returns {string} */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** parse a JSONL file into rows, skipping any partial/corrupt trailing line
 * (a file mid-append, or genuine corruption — never fatal to the rest).
 * @param {string} path @returns {any[]} */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial/corrupt line — skip, keep the rest */
    }
  }
  return out;
}

/** platform message_id -> this room's own frame `seq`, both directions.
 * Pure read; rebuilt fresh per call (a room's own external.jsonl/
 * frames.jsonl are small enough that no cache is kept across calls — a
 * caller that polls often, seat.mjs's own apply(), pays a cheap re-read
 * each time rather than an incremental one; a later optimization, not
 * needed for this task's own room sizes).
 * @param {string} runDir @returns {Map<string, number>} */
export function buildMessageIndex(runDir) {
  const external = readJsonl(join(runDir, "external.jsonl"));
  /** @type {Map<string, number>} */
  const index = new Map();
  for (const row of external) {
    if (row?.direction === "out" && row.message_id != null && typeof row.seq === "number")
      index.set(String(row.message_id), row.seq);
  }
  const inbound = external.filter((r) => r?.direction === "in" && r.message_id != null);
  if (inbound.length) {
    const frames = readJsonl(join(runDir, "frames.jsonl")).filter((f) => f?.type === "message");
    let cursor = 0;
    for (const row of inbound) {
      if (typeof row.echo_of_seq === "number") {
        index.set(String(row.message_id), row.echo_of_seq);
        continue; // no `message` frame was ever written for a being's own echo
      }
      let matched = -1;
      for (let i = cursor; i < frames.length; i++) {
        const f = frames[i];
        if (f.by !== row.author) continue;
        if (row.text_sha && sha256(String(f.text ?? "").trim()) !== row.text_sha) continue;
        matched = i;
        break;
      }
      if (matched === -1) continue; // not found (yet) — an honest miss, never guessed
      index.set(String(row.message_id), frames[matched].seq);
      cursor = matched + 1;
    }
  }
  return index;
}

/** the frame seq a platform message_id resolves to in this room, or null.
 * @param {string} runDir @param {string} messageId @returns {number|null} */
export function frameSeqForMessageId(runDir, messageId) {
  return buildMessageIndex(runDir).get(String(messageId)) ?? null;
}

/** the CURRENT set of handles hiding frame `target` (frame-schema.mjs's
 * HiddenFrame `by` — empty means visible again, the last hider undid it,
 * RX2): the LATEST "hidden" frame written for this target, or [] when none
 * exists yet (never hidden).
 * @param {string} framesPath @param {number} target @returns {string[]} */
export function currentHiddenBy(framesPath, target) {
  let latest = null;
  for (const f of readJsonl(framesPath)) {
    if (f?.type === "hidden" && f.target === target) latest = f;
  }
  return Array.isArray(latest?.by) ? latest.by : [];
}

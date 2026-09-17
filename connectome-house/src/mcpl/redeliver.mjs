// @ts-check
// harness/src/mcpl/redeliver.mjs — a not-ready outbound row is retried
// once, within the catch-up window, next time the host reaches ready.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { identityMapReverse } from "../identity-map.mjs";
import { hydrateSpeech } from "../frames-io.mjs";
import { adapterFor, isDMStream } from "./adapters.mjs";
import {
  messageIdOf,
  recordOutbound,
  rewriteOutboundMentions,
  splitForPlatform,
} from "./outbound.mjs";
import { selfDisplayFor } from "./self-display.mjs";

// placeholder default (keeper's to change): a not-ready row older than
// this is left as it stands, never blind-retried.
export const CATCHUP_MS = 60 * 60 * 1000;

/** every "out" row still owed a retry: delivered:false, reason:not-ready,
 * not already retried, within `windowMs` of `now`.
 * @param {string} runDir @param {{windowMs?: number, now?: number}} [opts]
 * @returns {{seq: number, by: string}[]} */
export function pendingRedeliveries(runDir, { windowMs = CATCHUP_MS, now = Date.now() } = {}) {
  const p = join(runDir, "external.jsonl");
  if (!existsSync(p)) return [];
  const rows = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const alreadyRetried = new Set(
    rows.map((r) => r.redelivered_of).filter((s) => typeof s === "number"),
  );
  return rows
    .filter(
      (r) =>
        r.direction === "out" &&
        r.delivered === false &&
        r.reason === "not-ready" &&
        typeof r.seq === "number" &&
        !alreadyRetried.has(r.seq) &&
        now - Date.parse(r.t) <= windowMs,
    )
    .map((r) => ({ seq: r.seq, by: r.by }));
}

/** the speech (or house receipt) frame at `seq`, or null.
 * @param {string} runDir @param {number} seq @returns {any} */
function frameAtSeq(runDir, seq) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (f.seq === seq) return f;
    } catch {
      // a torn line names no frame
    }
  }
  return null;
}

/** one redelivery, through the same tool speak.mjs itself calls — a
 * fresh outbound row, never a silent rewrite of the old one.
 * @param {{cfg: object, host: object, say: (line: string) => void}} deps
 * @param {string} runDir @param {string} stream
 * @param {{seq: number, by: string}} item @param {string} text */
async function redeliverOne({ cfg, host, say }, runDir, stream, item, text) {
  const adapter = adapterFor(/** @type {any} */ (cfg).platform);
  const rewritten = rewriteOutboundMentions(text, {
    platform: /** @type {any} */ (cfg).platform,
    being: /** @type {any} */ (cfg).being,
    beingId: /** @type {any} */ (cfg).being_id,
    beingDisplay: selfDisplayFor(/** @type {any} */ (cfg).platform, /** @type {any} */ (cfg).being),
    mentionToken: adapter.mentionToken,
    reverse: identityMapReverse,
    isDM: isDMStream(adapter, stream),
  });
  const [content] = splitForPlatform(rewritten, /** @type {any} */ (cfg).limit);
  if (!content) return;
  try {
    const result = await /** @type {any} */ (host).callTool("send_message", {
      channelId: stream,
      content,
    });
    recordOutbound(runDir, {
      platform: /** @type {any} */ (cfg).platform,
      message_id: messageIdOf(result),
      by: item.by,
      seq: item.seq,
      redelivered_of: item.seq,
    });
  } catch (e) {
    say(`redelivery of seq ${item.seq} in ${stream} failed again: ${e.message}`);
  }
}

/** every pending redelivery for one room, applied.
 * @param {{cfg: object, host: object, say: (line: string) => void}} deps
 * @param {string} stream @param {string} runDir */
export async function redeliverRoom(deps, stream, runDir) {
  for (const item of pendingRedeliveries(runDir)) {
    const frame = frameAtSeq(runDir, item.seq);
    if (!frame) continue;
    const text =
      frame.type === "speech" || frame.type === "message"
        ? hydrateSpeech(frame, runDir).inline
        : frame.text;
    if (typeof text === "string" && text.trim())
      await redeliverOne(deps, runDir, stream, item, text);
  }
}

/** a not-ready→ready edge watcher: redelivers every tailed room's own
 * pending rows once, the moment the host first reaches that state.
 * @param {{cfg: object, host: {state: {state: string}}, say: (line: string) => void}} deps */
export function createRedeliverWatcher(deps) {
  let wasReady = false;
  return {
    /** @param {Map<string, {stream: string, runDir: string}>} tails */
    check(tails) {
      const ready = deps.host.state.state === "ready" || deps.host.state.state === "degraded";
      if (ready && !wasReady)
        for (const t of tails.values()) void redeliverRoom(deps, t.stream, t.runDir);
      wasReady = ready;
    },
  };
}

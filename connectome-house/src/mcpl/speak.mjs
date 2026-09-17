// @ts-check
/* harness/src/mcpl/speak.mjs — the outbound half of one seat: a room's
 * record → the platform. `@handle` in the being's speech is rewritten to
 * the platform's own mention form (outbound.mjs's rewriteOutboundMentions)
 * before the split at the platform's limit — a length-sensitive rewrite,
 * so it must run first; each delivered id lands in external.jsonl. A
 * refusal the platform or the grant made is recorded as a `delivered:
 * false` row and announced once as a house line, never dropped in
 * silence. Extracted from seat.mjs (2026-09-10, platform-reach) to keep
 * that file under its own line-length ratchet. */
import { join } from "node:path";
import { identityMapReverse } from "../identity-map.mjs";
import { appendHouseFrame } from "../frames-io.mjs";
import { open } from "../open-rooms.mjs";
import { adapterFor, isDMStream } from "./adapters.mjs";
import { GrantRefused } from "./calls.mjs";
import { humanBytes, resolveOutboundMedia, toolArgsFor } from "./media-out.mjs";
import {
  messageIdOf,
  recordOutbound,
  rewriteOutboundMentions,
  splitForPlatform,
} from "./outbound.mjs";
import { selfDisplayFor } from "./self-display.mjs";
import { sendLine } from "../seat/protocol.mjs";

/** @param {{cfg: import("./config.mjs").ServerConfig,
 *   host: {state: {tools: string[]}, callTool: (name: string, args: object) => Promise<unknown>},
 *   stats: {sent: number, undelivered: number}, say: (line: string) => void, RUNS: string}} deps */
export function createSpeaker({ cfg, host, stats, say, RUNS }) {
  /** a house line into the room's record: through the live child (recorded
   * `by: "house"`, observed — no turn), else appended as a house frame */
  function houseLine(roomId, text) {
    const rec = open.get(roomId);
    if (rec?.status === "open" && rec.seat) {
      sendLine(rec, { by: "house", text, observe: true });
      return;
    }
    const frame = { type: "message", by: "house", text, to: [] };
    appendHouseFrame(join(RUNS, roomId, "frames.jsonl"), frame);
  }

  /** the platform did not take the words (the grant refused the call, or
   * the wire did): a `delivered: false` row in the sidecar and a house
   * line in the room, so the record says so — never a silent drop.
   * `what` lets a media send name itself (an attachment, not a speech). */
  function undelivered(roomId, stream, { by, seq, name, error, what }) {
    const reason = error instanceof GrantRefused ? error.reason : "error";
    stats.undelivered += 1;
    say(`${name} to ${stream} not delivered (${reason}): ${error.message}`);
    recordOutbound(join(RUNS, roomId), {
      platform: cfg.platform,
      by,
      seq,
      delivered: false,
      reason,
      error: error.message,
    });
    const said = what ?? (by === "house" ? "the house's receipt" : `what @${by} just said`);
    houseLine(
      roomId,
      `[${cfg.platform} did not take ${said} — ${error.message}; it stands in the record, unsent]`,
    );
  }

  /** a room's own final speech (or a threshold receipt) → the platform */
  async function speak(roomId, stream, text, { by, replyTo = null, seq = null }) {
    const adapter = adapterFor(cfg.platform);
    const rewritten = rewriteOutboundMentions(text, {
      platform: cfg.platform,
      being: cfg.being,
      beingId: cfg.being_id,
      beingDisplay: selfDisplayFor(cfg.platform, cfg.being),
      mentionToken: adapter.mentionToken,
      reverse: identityMapReverse,
      isDM: isDMStream(adapter, stream),
    });
    const chunks = splitForPlatform(rewritten, cfg.limit);
    let first = true;
    for (const content of chunks) {
      const useReply = first && replyTo && host.state.tools.includes("reply_message");
      const name = useReply ? "reply_message" : "send_message";
      const args = useReply
        ? { channelId: stream, messageId: replyTo, content }
        : { channelId: stream, content };
      try {
        const result = await host.callTool(name, args);
        stats.sent += 1;
        recordOutbound(join(RUNS, roomId), {
          platform: cfg.platform,
          message_id: messageIdOf(result),
          by,
          seq,
          reply_to: useReply ? replyTo : null,
        });
      } catch (e) {
        undelivered(roomId, stream, { by, seq, name, error: e });
        return;
      }
      first = false;
    }
  }

  /** a room's own `media.attached` frame → a real platform attachment
   * (contract 5): resolved and size-capped by media-out.mjs; over the
   * cap, unsupported, or unresolvable, an honest text line names the
   * address instead of guessing at a call. Never threaded onto the
   * being's own reply-to id — that queue answers the turn's FINAL speech
   * only (pendingReply.take in seat.mjs), and a mid-turn attachment must
   * not consume it first. Same delivery ledger as speak(): recordOutbound
   * keyed on the frame's own `seq`, so a restart never re-sends.
   * @param {string} roomId @param {string} stream
   * @param {{path: string, filename?: string|null}} f
   * @param {{by: string, seq: number|null}} opts */
  async function speakMedia(roomId, stream, f, { by, seq }) {
    const resolved = resolveOutboundMedia(f, cfg.platform);
    if (!resolved.ok) {
      // the fallback text's own speak() call records this seq either way —
      // one row is enough for the cursor; this frame is never retried.
      const why =
        resolved.reason === "too-large"
          ? `is ${humanBytes(resolved.bytes ?? 0)} — over ${cfg.platform}'s outbound ceiling`
          : resolved.reason === "unsupported"
            ? `has no known attachment shape on ${cfg.platform}`
            : "could not be resolved here";
      return void speak(roomId, stream, `[@${by}'s attachment ${why} — its address is ${f.path}]`, {
        by: "house",
        seq,
      });
    }
    const name = "send_message";
    try {
      const result = await host.callTool(name, {
        channelId: stream,
        ...toolArgsFor(cfg.platform, resolved),
      });
      stats.sent += 1;
      recordOutbound(join(RUNS, roomId), {
        platform: cfg.platform,
        message_id: messageIdOf(result),
        by,
        seq,
      });
    } catch (e) {
      undelivered(roomId, stream, { by, seq, name, error: e, what: `@${by}'s attachment` });
    }
  }

  return { speak, speakMedia, houseLine };
}

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
import { memoryGet } from "../commands/store.mjs";
import { open } from "../open-rooms.mjs";
import { roomSlug } from "../serve-room-open.mjs";
import { adapterFor, isDMStream } from "./adapters.mjs";
import { GrantRefused } from "./calls.mjs";
import { humanBytes, resolveOutboundMedia, toolArgsFor } from "./media-out.mjs";
import {
  messageIdOf,
  recordOutbound,
  rewriteOutboundMentions,
  splitForDiscordFork,
  splitForPlatform,
} from "./outbound.mjs";
import { selfDisplayFor } from "./self-display.mjs";
import { sendLine } from "../seat/protocol.mjs";

/** W3-A, 2026-09-18: a pre-agentic model (`claude-3-opus` probe) emits
 * literal `<thinking>…</thinking>` text rather than a real thinking block —
 * connectome-agent-core/src/utils.ts:64's own strip, mirrored on this
 * outbound path only; the record (frames.jsonl) keeps the frame verbatim. */
function stripThinkingBlocks(text) {
  return typeof text === "string" ? text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "") : text;
}

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

  /** harness-port P-F, 2026-09-17 (mission task 2; 08-pilot-observe.md
   * §2): an observe_only seat's own suspenders — route.mjs's activation
   * gate (belt) stops every path that goes THROUGH a turn, but the
   * `!`-command reply lane (room-tails.mjs's applyCommandAction) calls
   * speak() directly, bypassing it — so this check has to sit HERE too,
   * before any host.callTool, on every call regardless of caller. Recorded
   * like any other outbound row (a caller can see the would-be send was
   * suppressed, never silently dropped), just never sent. */
  function observeOnlyRefusal(roomId, by, seq) {
    if (!cfg.observe_only) return false;
    recordOutbound(join(RUNS, roomId), {
      platform: cfg.platform,
      by,
      seq,
      delivered: false,
      reason: "observe_only",
      error: "this seat is observe_only — nothing is ever sent",
    });
    return true;
  }

  // `!split`'s (C9, Signal only) own soft-split threshold, read live at send
  // time (commands/registry.mjs's own `split` command; harness-port Q1-C,
  // 2026-09-18: 02-user-contract.md C9's target home — "read live by the
  // Signal MCPL server's own splitter"). `roomId` throughout this file is
  // this seat's own run id, NOT the command lane's `` `${platform}:
  // ${roomSlug}` `` key (room-turn.mjs's own `commandRoomKeyFor` header
  // explains the same split); `stream` is what carries the real room key's
  // shape here, matching mcpl/seat.mjs's own `roomKeyOf`. 0 ("native"/
  // "off") means no soft split at all — one chunk, still bounded by the
  // platform's own hard `cfg.limit`. Every other platform is unaffected.
  const SIGNAL_SPLIT_DEFAULT = 400; // signal-command-effector.ts's own env-configured default; matches registry.mjs's own !split entry
  function splitLimitFor(stream) {
    if (cfg.platform !== "signal") return cfg.limit;
    const setting = memoryGet(`${cfg.platform}:${roomSlug(stream)}`, "split", SIGNAL_SPLIT_DEFAULT);
    return setting > 0 ? Math.min(setting, cfg.limit) : cfg.limit;
  }

  /** a room's own final speech (or a threshold receipt) → the platform */
  async function speak(roomId, stream, text, { by, replyTo = null, seq = null }) {
    if (observeOnlyRefusal(roomId, by, seq)) return;
    const adapter = adapterFor(cfg.platform);
    const rewritten = rewriteOutboundMentions(stripThinkingBlocks(text), {
      platform: cfg.platform,
      being: cfg.being,
      beingId: cfg.being_id,
      beingDisplay: selfDisplayFor(cfg.platform, cfg.being),
      mentionToken: adapter.mentionToken,
      reverse: identityMapReverse,
      isDM: isDMStream(adapter, stream),
    });
    // harness-port P-C, 2026-09-17 (02-user-contract.md O13): Discord's own
    // chunk boundaries are asked to match the fork's, byte for byte —
    // splitForPlatform's paragraph-repacking (a real house improvement,
    // kept for every other platform) would not. See splitForDiscordFork's
    // own comment (outbound.mjs) and discord.mjs's `LIMIT` for why 1900,
    // not the fork's 2000, is still the right operative number here.
    const chunks =
      cfg.platform === "discord"
        ? splitForDiscordFork(rewritten, cfg.limit)
        : splitForPlatform(rewritten, splitLimitFor(stream));
    let first = true;
    for (const content of chunks) {
      // harness-port P-C, 2026-09-17 (02-user-contract.md O16, coordinator
      // relay of P-B's mcpl-signal/PARITY.md finding): a native reply is
      // used only when BOTH the platform's own fork actually threads
      // replies (adapters.mjs's per-platform `replyThreading` — false for
      // both registered platforms today, each cited at its own adapter)
      // AND the server exposes the tool. A server capability alone is
      // never enough — discord-mcpl's `reply_message` exists and works,
      // but the fork it must match never calls it.
      const useReply =
        first && replyTo && adapter.replyThreading && host.state.tools.includes("reply_message");
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
    if (observeOnlyRefusal(roomId, by, seq)) return;
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

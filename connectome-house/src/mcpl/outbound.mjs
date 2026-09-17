// @ts-check
/* harness/src/mcpl/outbound.mjs — the pure half of speaking back: rewrite
 * `@handle` in a being's speech to the platform's own mention form
 * (rewriteOutboundMentions), split a being's speech at a platform's message
 * limit on paragraph boundaries (then lines, then a hard cut), read the
 * `messageId` a server's send tool returns (discord-mcpl wraps
 * `{messageId}` as JSON in one text block; a bare id or a `messageId: …`
 * phrase are read too), the external.jsonl row shape for a delivered
 * message, and the house's own notice text for a failed turn
 * (providerErrorNotice, errors_to_chat — config.mjs). */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** `@handle` tokens in outbound text — the same handle grammar as
 * testaments.mjs's HANDLE_RE, word-bounded so a handle can't shadow-match
 * inside a longer one. */
const OUTBOUND_MENTION_RE = /@([a-z0-9][a-z0-9-]{1,23})(?![\w-])/g;

/** `@handle` in a being's outgoing speech → the platform's own mention form
 * for identities the house can address there, through the adapter seam:
 * the server's own being → its known platform display name, or the
 * platform's mention token when its own platform id is known (so Discord's
 * `<@id>` renders a real, working ping); a human or other identity the
 * house has mapped → the platform's mention token via `reverse`
 * (identityMapReverse); unknown to the house → left as literal text, never
 * fabricated. `isDM`: a platform mention does nothing in a DM (the other
 * party is already known) and Signal Desktop drops the mention range
 * entirely there, leaving a bare placeholder box — so a DM skips this
 * rewrite altogether and `@handle` goes out exactly as written.
 * @param {string} text
 * @param {{platform: string, being: string, beingId: string|null,
 *   beingDisplay: string|null, mentionToken: (id: string) => string,
 *   reverse: (handle: string, platform: string) => {id: string}|null,
 *   isDM?: boolean}} deps
 * @returns {string} */
export function rewriteOutboundMentions(
  text,
  { platform, being, beingId, beingDisplay, mentionToken, reverse, isDM = false },
) {
  const src = String(text ?? "");
  if (isDM) return src;
  return src.replace(OUTBOUND_MENTION_RE, (full, handle) => {
    if (handle === being) {
      if (beingId) return mentionToken(beingId);
      return beingDisplay ? `@${beingDisplay}` : full;
    }
    const hit = reverse(handle, platform);
    return hit ? mentionToken(hit.id) : full;
  });
}

/** @param {string} text @param {number} limit @returns {string[]} */
export function splitForPlatform(text, limit) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  const push = (piece) => {
    if (piece.length > limit) {
      flush();
      for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit));
      return;
    }
    const sep = cur ? "\n\n" : "";
    if (cur.length + sep.length + piece.length > limit) flush();
    cur = cur ? `${cur}\n\n${piece}` : piece;
  };
  for (const para of t.split(/\n{2,}/)) {
    if (para.length <= limit) {
      push(para);
      continue;
    }
    // a paragraph over the limit: line by line, joined with single newlines
    let block = "";
    for (const line of para.split("\n")) {
      if (line.length > limit) {
        if (block) push(block);
        block = "";
        push(line);
        continue;
      }
      const sep = block ? "\n" : "";
      if (block.length + sep.length + line.length > limit) {
        push(block);
        block = line;
      } else block = block ? `${block}\n${line}` : line;
    }
    if (block) push(block);
  }
  flush();
  return out;
}

/** harness-port P-C, 2026-09-17 (docs/harness-port/02-user-contract.md
 * O13): the fork's OWN Discord splitting algorithm, ported 1:1 from
 * discord-axon/src/grpc/utils/message-splitter.ts's `splitMessage` — a
 * single linear pass, cutting at the last newline at or before `limit`,
 * else the last space, else a hard cut at `limit`; never repacks several
 * short paragraphs together the way `splitForPlatform` above does. Kept
 * as its OWN function, deliberately not folded into `splitForPlatform`:
 * that function's paragraph-repacking is a real, considered house
 * improvement for other platforms (denser chunks, fewer messages) — this
 * one exists only so Discord's own chunk boundaries can be asked to
 * match the fork's, byte for byte, which repacking would break. Called
 * with `limit = discord.mjs`'s `LIMIT` (1900, not the fork's 2000 — see
 * that constant's own comment for why the operative number differs from
 * the fork's even though the ALGORITHM is identical).
 * @param {string} content @param {number} [limit]
 * @returns {string[]} */
export function splitForDiscordFork(content, limit = 1900) {
  const src = String(content ?? "");
  if (!src) return [];
  if (src.length <= limit) return [src];
  const chunks = [];
  let remaining = src;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex === -1 || splitIndex < limit / 2) splitIndex = remaining.lastIndexOf(" ", limit);
    if (splitIndex === -1 || splitIndex < limit / 2) splitIndex = limit;
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
  return chunks;
}

/** harness-port P-C, 2026-09-17 (02-user-contract.md O29): the fork's OWN
 * error-text shapes, ported 1:1 from `formatErrorForChat`
 * (connectome-agent-core/src/connectome-effector.ts:31-56) — replaces
 * this function's earlier "house: @being's turn failed — status type:
 * detail" prose, which matched none of the fork's four shapes
 * (`[Anthropic API …]`, `[Refused: …]`, `[Model stop_reason=…]`,
 * `[Error] …`) and was never asked for by anything on disk (no test, no
 * fixture referenced the old text — checked before changing it).
 * A pre-formatted refusal/stop-reason notice (anthropic-refusal-
 * capture.ts's own `[Refused: <category>]` / `[Model stop_reason=
 * <reason>]` prefix) passes through unchanged, truncated at 500 chars
 * with a literal `...` (the fork's own suffix, not the single-glyph `…`
 * this file used before); a JSON API error body becomes `[Anthropic API
 * <type>] <message>` — UNtruncated, matching the fork's own code, which
 * has no length check on this branch; anything else falls back to
 * `[Error] <message>`, truncated the same way.
 *
 * KNOWN GAP, NOT CLOSED HERE (handoff — mcpl/seat.mjs is NO-TOUCH for
 * this task): the fork delivers this text AS THE BEING'S OWN SPEECH,
 * `by: being` — this house's seat.mjs calls `speak(roomId, stream,
 * notice, { by: "house", seq: f.seq })` (seat.mjs:290-292) and also
 * writes it as a `houseLine`, so today it always arrives voiced as the
 * house, never as the being. The TEXT shape below is now byte-parity
 * with the fork; the SPEAKER identity is a separate, structural
 * difference — see PARITY-discord.md row O29 for the exact diff
 * seat.mjs would need (drop the `houseLine` call, pass `by: cfg.being`).
 * `being` is accepted for call-site compatibility only — the fork's own
 * formatter takes no being name at all.
 * @param {string} being @param {string|undefined} message @returns {string} */
export function providerErrorNotice(being, message) {
  const msg = String(message ?? "");
  const truncate = (s) => (s.length > 500 ? `${s.slice(0, 500)}...` : s);
  if (msg.startsWith("[Refused:") || msg.startsWith("[Model stop_reason=")) return truncate(msg);
  const jsonStart = msg.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(msg.slice(jsonStart));
      if (body?.error?.message) {
        const errType = body.error.type || "unknown";
        return `[Anthropic API ${errType}] ${body.error.message}`;
      }
    } catch {
      /* not JSON, or no error.message — fall through to the generic shape */
    }
  }
  return `[Error] ${truncate(msg)}`;
}

/** the messageId a tools/call send result carries, or null
 * @param {unknown} result @returns {string|null} */
export function messageIdOf(result) {
  const r = /** @type {any} */ (result);
  if (r && typeof r === "object") {
    if (typeof r.messageId === "string") return r.messageId;
    if (r.isError) return null;
    const texts = Array.isArray(r.content)
      ? r.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text)
      : [];
    for (const text of texts) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j.messageId === "string") return j.messageId;
      } catch {
        const m = text.match(/messageId["':\s]+([A-Za-z0-9_-]+)/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

/** how many inbound message ids a being may owe answers to, per room,
 * before the oldest is let go — a turn that ends without speech leaves
 * its id behind, and a busy room would otherwise grow the queue forever */
export const PENDING_REPLY_CAP = 8;

/** the reply pairing: per `(room, being)`, the inbound message ids still
 * to be answered, oldest first — the child runs turns in order, so the
 * being's next final speech answers the oldest. Bounded at
 * PENDING_REPLY_CAP (drop-oldest); a room's queues clear when it rests
 * or dissolves. */
export function createReplyQueue(cap = PENDING_REPLY_CAP) {
  /** @type {Map<string, string[]>} */
  const queues = new Map();
  const key = (roomId, being) => `${roomId} ${being}`;
  return {
    /** @param {string} roomId @param {string} being @param {string} messageId */
    push(roomId, being, messageId) {
      const q = [...(queues.get(key(roomId, being)) ?? []), messageId];
      queues.set(key(roomId, being), q.slice(-cap));
    },
    /** the oldest id owed, or null @param {string} roomId @param {string} being */
    take(roomId, being) {
      return queues.get(key(roomId, being))?.shift() ?? null;
    },
    /** @param {string} roomId */
    clear(roomId) {
      for (const k of queues.keys()) if (k.startsWith(`${roomId} `)) queues.delete(k);
    },
    /** @param {string} roomId @param {string} being */
    size: (roomId, being) => queues.get(key(roomId, being))?.length ?? 0,
  };
}

/** append one outbound row to the run's external.jsonl — the same
 * append-only sidecar roomInput writes inbound rows to; `direction:
 * "out"` tells them apart. A delivered row carries the platform's
 * message id; a refused one carries `delivered: false` and why, so a
 * speech the platform never took still has a trace here. `seq` is the
 * speech frame's seq — the seat's delivery cursor across restarts.
 * `redelivered_of` (redeliver.mjs) names the seq a not-ready row is
 * being retried for — a fresh row, never a rewrite of the old one.
 * @param {string} runDir
 * @param {{platform: string, by: string, reply_to?: string|null, seq?: number|null,
 *   message_id?: string|null, delivered?: boolean, reason?: string, error?: string,
 *   redelivered_of?: number}} row */
export function recordOutbound(
  runDir,
  { platform, by, reply_to, seq, message_id, redelivered_of, ...rest },
) {
  appendFileSync(
    join(runDir, "external.jsonl"),
    `${JSON.stringify({
      t: new Date().toISOString(),
      direction: "out",
      platform,
      delivered: rest.delivered !== false,
      ...(rest.delivered === false ? { reason: rest.reason, error: rest.error } : { message_id }),
      by,
      ...(seq != null ? { seq } : {}),
      ...(reply_to ? { reply_to } : {}),
      ...(redelivered_of != null ? { redelivered_of } : {}),
    })}\n`,
  );
}

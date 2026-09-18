// @ts-check
/* connectome-house/src/context-settings.mjs — !mcf/!mmf/!h-default's (C4/
 * C5/C7) own render-time budget for a rendered conversation slice.
 * Extracted from room-turn.mjs (harness-port Q1-C, 2026-09-18) to keep
 * that file under its own line-length ratchet — pure with respect to a
 * room's own frames: reads only commands/store.mjs's settings tiers,
 * never touches frames.jsonl itself. Original consumer (P-A, 2026-09-17)
 * doc comments carried forward unchanged below. */
import { memoryGet, roomSettingsGet } from "./commands/store.mjs";

/** the server-side activation-context render budget's own default, ported
 * from the fork's `ACTIVATION_CONTEXT_MAX_FRAMES` (00-stack-as-is.md
 * §1.5) — `!mcf`'s own query text falls back to this same number
 * (fork-replies.mjs's `mcf.query`/`mcf.reset`). */
export const SERVER_DEFAULT_MAX_FRAMES = 400;

/** `!mcf`'s (C4) own effective frames budget for (roomId, handle): a
 * per-bot override first, then the stream-wide '*' override, then the
 * server default — the exact order discord/signal-command-effector.ts's
 * own query path reads it in (registry.mjs's `mcf` command; see its own
 * "NAMED GAP" comment for the one query-vs-targeted subtlety this port
 * approximates). @param {string|null} roomId @param {string} handle */
export function mcfBudget(roomId, handle) {
  if (roomId == null) return SERVER_DEFAULT_MAX_FRAMES; // no stream at all (a synthetic room) — no `!mcf` could ever have targeted it
  const botVal = memoryGet(roomId, `context.max_frames:${handle}`, undefined);
  if (botVal !== undefined) return botVal;
  const streamVal = memoryGet(roomId, "context.max_frames:*", undefined);
  if (streamVal !== undefined) return streamVal;
  return SERVER_DEFAULT_MAX_FRAMES;
}

/** harness-port P-A (parity round, 2026-09-17) — mission task 2's own
 * consumer: `!mcf`/`!mmf`/`!h-default` (commands/registry.mjs) all
 * persist a value that nothing read back before this round (commands/
 * store.mjs's own header, prior rounds' "NAMED GAP"). This is that read,
 * applied per room and per @bot-scoped override exactly as the fork
 * scopes each one:
 * - `!mcf` (being-in-room): `mcfBudget`, above.
 * - `!mmf` (global — the fork's own RuntimeConfig.maxMemoryFrames has no
 *   streamId either, and NO consumer reads it back in the fork at all,
 *   00 §4.3): applied here as a further, GLOBAL cap — whichever of mcf/
 *   mmf resolves smaller wins. A "change, argued" (this task's report):
 *   the fork itself never gives `!mmf` a real effect; this port does.
 * - `!h-default` (being-in-room, persisted): the fork's own "glue !hN to
 *   every activation" (C7) — applied AFTER mcf/mmf, as a further tail
 *   trim to the last (N + 1) messages (N history + the newest/triggering
 *   one) when set for this (room, being); unset leaves mcf/mmf's own cap
 *   as the final word.
 * @param {{participant: string, content: string}[]} rendered
 * @param {string|null} roomId @param {string} handle */
export function trimForContextSettings(rendered, roomId, handle) {
  const mcfCap = mcfBudget(roomId, handle);
  const mmfCap = memoryGet(null, "memory.max_frames", SERVER_DEFAULT_MAX_FRAMES);
  const cap = Math.min(mcfCap, mmfCap);
  let out = cap > 0 && rendered.length > cap ? rendered.slice(-cap) : rendered;
  const hDefault = roomId == null ? undefined : roomSettingsGet(roomId, `context.history_default:${handle}`, undefined);
  if (typeof hDefault === "number" && hDefault >= 0) {
    const tail = hDefault + 1;
    out = out.length > tail ? out.slice(-tail) : out;
  }
  return out;
}

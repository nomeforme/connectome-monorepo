// @ts-check
/* connectome-history-import/src/room-shape.mjs — the small, stateless
 * shape helpers records.mjs's `buildRoom` and slice.mjs's own append path
 * both need: what's lost on import, a room's own id, an attachment's media
 * kind, an item's external id, a stream's visibility, and slice.mjs's own
 * import-lock file pair. Extracted from records.mjs (2026-09-18), then
 * slice.mjs (2026-09-18, the same round), to keep each file under its own
 * line budget as the speech/human/system re-classing logic (beings.mjs)
 * grew them past the cap.
 */
import { closeSync, openSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const LOST = [
  "replies", // reply/quote targets were never stored upstream (event-handler.ts:129-138, 196-206)
  "reactions", // every reaction but 🫥 was dropped at ingest (event-handler.ts:414-417)
  "typing", // typing indicators were events without facets
  "ambient", // veil:ambient nudges and bot-config facets — harness state, not the conversation
  "activations", // agent-activation / rendered-context facets — derived views of the same history
];

/** deterministic 4-char tail from the stream key — the house's own tail
 * is random (same-second mints apart); an import wants the same id twice. */
export const importTail = (key) =>
  createHash("sha256").update(`veil-import:${key}`).digest("hex").slice(0, 4);

/** the room's run id, in the house's own shape (serve-room-open.mjs's
 * `roomSlug` + serve-rooms.mjs's own id convention):
 * `room-<platform>-<slug8>-<stamp>-<4>`, stamped with the stream's FIRST
 * frame time so ids sort chronologically beside live ones. */
export function roomId({ platform, key, slug8, firstT }) {
  const stamp = String(firstT ?? new Date(0).toISOString())
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return `room-${platform}-${slug8}-${stamp}-${importTail(key)}`;
}

export const kindOfMime = (mime) => {
  const m = String(mime ?? "");
  return m.startsWith("image/")
    ? "image"
    : m.startsWith("audio/")
      ? "audio"
      : m.startsWith("video/")
        ? "video"
        : "other";
};

/** the external id an item is recorded under — a real platform message id
 * when there is one, else a PREFIXED stand-in that can never collide with
 * one: `veil-t:<iso>` for a message, `veil-facet:<id>` for undelivered
 * speech. Shared by a fresh import (records.mjs) and a later slice
 * (slice.mjs), so the same item always lands under the same id.
 * @param {import("./streams.mjs").StreamGroup["items"][number]} it
 * @param {Map<string, {platform: string, messageId: string|null}>} delivered
 * @returns {string|null} */
export function externalIdOf(it, delivered) {
  if (it.kind === "message") return it.messageId ?? `veil-t:${it.t}`;
  if (it.kind === "speech") return delivered.get(it.facetId)?.messageId ?? `veil-facet:${it.facetId}`;
  return null;
}

/** a public room is a guild channel anyone could read; everything else —
 * a Signal group or DM, a Discord DM, a web session — is the people's own. */
export function visibilityOf(platform, key) {
  if (platform === "discord" && !key.startsWith("discord:dm:")) return "public";
  return "private";
}

/** O_CREAT|O_EXCL: null if another process already holds it.
 * @param {string} runDir @returns {string|null} */
export function acquireImportLock(runDir) {
  const path = join(runDir, ".import.lock");
  try {
    closeSync(openSync(path, "wx"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return null;
    throw e;
  }
  return path;
}

export function releaseImportLock(path) {
  try {
    unlinkSync(path);
  } catch {
    /* already gone — nothing to clean up */
  }
}

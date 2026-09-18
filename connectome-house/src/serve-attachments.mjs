// @ts-check
/* connectome-house/src/serve-attachments.mjs — validating an `attachments`
 * array riding into a room on a message: every address must be a
 * `blob/<sha>` that actually exists in this box's shared blob store
 * (blob-root.mjs), read off its own sidecar (mime/filename), never
 * re-derived. One bad address refuses the WHOLE message, never a partial
 * drop. Shared by `serve-rooms.mjs`'s `roomInput` and
 * `serve-media-upload.mjs`'s own upload route.
 *
 * Ported from a private deployment's serve-attachments.mjs: that source
 * also gated a caller-supplied `who` against `serve-media.mjs`'s own
 * visibility resolver (a browsing/preview UI concern this port doesn't
 * carry — see connectome-house/README.md's "what was cut", the app/ media
 * layer). This port keeps only the existence check every caller here
 * actually needs; `serve-rooms.mjs` previously inlined this exact logic
 * (its own header noted the module was "out of scope" at the time) —
 * this file is that extraction, so the two copies don't drift.
 */
import { readBlobSidecar } from "./blob-root.mjs";
import { attachToRun } from "./media-share.mjs";

export const MAX_ATTACHMENTS = 10;

/** mime → the frame's coarse `kind` (image/audio/video/other) — a prefix
 * match only, good enough for the mime strings a platform attachment or
 * an app upload actually carries. */
export function kindOfMime(mime) {
  const m = String(mime ?? "");
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "other";
}

/** validate an `attachments` array for one message: every address must be
 * `blob/<sha>` and exist in the blob store. `undefined` (the common case
 * — most messages carry none) resolves to an empty, ok array; anything
 * else that isn't an array, or exceeds `MAX_ATTACHMENTS`, or names an
 * address this box doesn't have, refuses the WHOLE message.
 * @param {unknown} attachments
 * @returns {{ok:true, attachments: Array<{path:string,kind:string,mime:string,filename:string|null}>}
 *          |{ok:false, error:string}} */
export function resolveAttachments(attachments) {
  if (attachments === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(attachments)) return { ok: false, error: "attachments must be an array" };
  if (attachments.length > MAX_ATTACHMENTS)
    return { ok: false, error: `at most ${MAX_ATTACHMENTS} attachments` };
  const resolved = [];
  for (const raw of attachments) {
    const path = String(raw ?? "");
    if (!path.startsWith("blob/")) return { ok: false, error: `not a blob address: ${path}` };
    const sha = path.slice("blob/".length);
    const sidecar = readBlobSidecar(sha);
    if (!sidecar) return { ok: false, error: `no attachment at that address: ${path}` };
    resolved.push({
      path,
      kind: kindOfMime(sidecar.mime),
      mime: sidecar.mime ?? "application/octet-stream",
      filename: sidecar.filename ?? null,
    });
  }
  return { ok: true, attachments: resolved };
}

/** register a room reference on each already-resolved attachment
 * (media-share.mjs's `attachToRun` — an upload made before the run
 * existed becomes visible in it the moment it's sent into one).
 * @param {Array<{path:string}>|undefined} attachments @param {string} runId */
export function attachAllToRun(attachments, runId) {
  for (const a of attachments ?? []) attachToRun({ path: a.path, runId });
}

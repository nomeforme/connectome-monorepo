// @ts-check
/* harness/src/media-share.mjs — the producer side of house-wide shared
 * media (blob-root.mjs): puts bytes a HUMAN shares INTO a room — a
 * Discord image, a Signal photo, a VEIL-imported attachment — into the
 * content-addressed store, records the room's own reference in the
 * store's reverse index, and appends the room's `media.attached`
 * world-fact honestly: `requested_by: "human"`, `seen_by_model: false`
 * always — nothing here claims the model looked at it, that is still only
 * ever media_view's own reach (media-tools.mjs).
 *
 * A plain function, not a walker tool: there is no active-turn ctx here,
 * because the caller is outside any turn — the MCPL host seat receiving a
 * platform event, or the importer pouring history in. The frame lands as
 * a server-side house frame (frames-io.mjs's appendHouseFrame — a
 * fractional seq, since no live child here owns the room's next integer). */
import { basename, join } from "node:path";
import { addPendingRef, addRef, hasBlob, isValidSha, putBlob } from "./blob-root.mjs";
import { normalizeMedia } from "./media-normalize.mjs";
import { RUNS } from "./serve-paths.mjs";
import { appendHouseFrame, houseFrameSeq } from "./frames-io.mjs";

/** mime → the frame's coarse `kind` (frames.ts's MediaAttachedFrame union:
 * image/audio/video/other). A prefix match only — good enough for the
 * mime strings a platform attachment actually carries. */
function kindOfMime(mime) {
  const m = String(mime ?? "");
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "other";
}

/**
 * @param {{
 *   runDir: string,
 *   bytes: Uint8Array,
 *   mime: string,
 *   ext?: string,
 *   by: string,
 *   origin?: object,
 *   requestedBy?: "human"|"model",
 * }} args
 * @returns {{sha: string, path: string|null, existed: boolean, frame: object|null}}
 *   `frame` is null only if `runDir` has no frames.jsonl yet (an honest
 *   no-append rather than fabricating a room that isn't there) — the blob
 *   and its ref are still stored either way.
 */
export function shareBlobIntoRun({ runDir, bytes, mime, ext, by, origin, requestedBy = "human" }) {
  const { sha, path, existed } = putBlob(bytes, { mime, ext, origin });
  const run = basename(runDir);
  const framesPath = join(runDir, "frames.jsonl");
  addRef(sha, { run, seq: houseFrameSeq(framesPath) });
  const frame = appendHouseFrame(framesPath, {
    type: "media.attached",
    by,
    turn: 0,
    path: `blob/${sha}`,
    kind: kindOfMime(mime),
    seen_by_model: false,
    requested_by: requestedBy,
    sha,
    mime,
  });
  return { sha, path, existed, frame };
}

/**
 * The one ingress path for a file a person sends in — app upload or
 * platform attachment alike: normalizes (media-normalize.mjs), stores the
 * bytes, and refs a room when one is known, else a ref pending on
 * `uploader` alone (visible only to them, once a deployment wires viewability into its own media-serving route).
 * Writes NO frame — the caller decides when/where `media.attached` lands.
 * @param {{
 *   bytes: Uint8Array,
 *   contentType: string,
 *   filename?: string,
 *   origin: {via: string, room?: string},
 *   runId?: string,
 *   uploader?: string,
 * }} args
 * @returns {{path: string, kind: string, mime: string, bytes: number, width?: number, height?: number, filename?: string} | {error: string, code: string}}
 */
export function storeSharedMedia({ bytes, contentType, filename, origin, runId, uploader }) {
  const normalized = normalizeMedia({ bytes, mime: contentType, filename });
  if (normalized.error) return normalized;
  const { bytes: outBytes, mime, ext, kind, width, height } = normalized;
  const { sha } = putBlob(outBytes, { mime, ext, origin });
  if (runId) {
    addRef(sha, { run: runId, seq: houseFrameSeq(join(RUNS, runId, "frames.jsonl")) });
  } else {
    addPendingRef(sha, { uploader });
  }
  return {
    path: `blob/${sha}`,
    kind,
    mime,
    bytes: outBytes.length,
    ...(width && height ? { width, height } : {}),
    ...(filename ? { filename } : {}),
  };
}

/**
 * Ref an already-stored blob into a room — used when a pending upload (no
 * room yet at store time) is later sent into one. Writes no frame; honest
 * `{error}` for a malformed address or an unknown blob, never a throw.
 * @param {{path: string, runId: string}} args
 */
export function attachToRun({ path, runId }) {
  const sha = String(path ?? "").startsWith("blob/") ? path.slice("blob/".length) : "";
  if (!isValidSha(sha)) return { error: "not a blob address", code: "bad-address" };
  if (!hasBlob(sha)) return { error: "no blob at that address", code: "unknown-blob" };
  addRef(sha, { run: runId, seq: houseFrameSeq(join(RUNS, runId, "frames.jsonl")) });
  return { path: `blob/${sha}`, run: runId };
}

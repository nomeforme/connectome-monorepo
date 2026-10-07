// @ts-check
/* connectome-house/src/media-inline.mjs — what an attachment looks like in
 * a turn's live conversation: the real thing (an image, a PDF, a short
 * text file) for the room's most recent few, a pointer line for the rest.
 *
 * The record never gains bytes — frames.jsonl keeps the blob address
 * (`media.attached`); this module only decides, per rendered turn, which of
 * those addresses ride as content. "The newest few stay live" (the
 * connectome-host shape: a bounded count, a bounded depth) rather than
 * "once per being": the house re-renders the conversation every turn, so a
 * stateless rule keeps the request prefix stable between turns and lets a
 * being look at a recent picture again.
 */
import { readFileSync } from "node:fs";
import { resolveBlob } from "./blob-root.mjs";

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml", "application/x-ndjson"]);
const isText = (m) => typeof m === "string" && (m.startsWith("text/") || TEXT_MIME.has(m));
const PDF_MIME = "application/pdf";
const IMAGE_BYTES_CAP = 4 * 1024 * 1024; // the API's own per-image ceiling, rounded down
const PDF_BYTES_CAP = 16 * 1024 * 1024;
const TEXT_BYTES_CAP = 64 * 1024;

/** how many of the newest attachments ride live, and how far back (in
 * record frames) one may sit and still count as recent */
export const LIVE_MEDIA_COUNT = Number(process.env.HOUSE_LIVE_MEDIA_COUNT ?? 6);
export const LIVE_MEDIA_DEPTH_FRAMES = Number(process.env.HOUSE_LIVE_MEDIA_DEPTH ?? 120);

/** @param {{path?: string}} f */
const blobOf = (f) => {
  const sha = typeof f.path === "string" && f.path.startsWith("blob/") ? f.path.slice("blob/".length) : null;
  return sha ? resolveBlob(sha) : null;
};

/** the attachment's mime: the frame's own, else its blob's sidecar (a
 * being's media_attach frame never carried one) */
export const mimeOf = (f, blob = blobOf(f)) => f.mime ?? blob?.sidecar?.mime ?? null;

/** can this attachment's bytes reach a model at all (a kind we inline, under its cap)? */
export function isInlinable(f) {
  const blob = blobOf(f);
  if (!blob) return false;
  const bytes = Number(blob.sidecar?.bytes ?? 0);
  const mime = mimeOf(f, blob);
  if (IMAGE_MIME.has(mime)) return bytes <= IMAGE_BYTES_CAP;
  if (mime === PDF_MIME) return bytes <= PDF_BYTES_CAP;
  if (isText(mime)) return bytes <= TEXT_BYTES_CAP;
  return false;
}

/** the content block for one attachment, read fresh off the blob store —
 * null when the blob has since vanished or isn't a kind we inline (the
 * pointer line then stands; never a throw mid-render).
 * @param {{path?: string, mime?: string, filename?: string|null}} f */
export function attachmentBlock(f) {
  const blob = blobOf(f);
  if (!blob) return null;
  const mime = mimeOf(f, blob) ?? "";
  try {
    if (IMAGE_MIME.has(mime))
      return { type: "image", source: { type: "base64", data: readFileSync(blob.abs).toString("base64"), mediaType: mime } };
    if (mime === PDF_MIME)
      return {
        type: "document",
        source: { type: "base64", data: readFileSync(blob.abs).toString("base64"), mediaType: mime },
        ...(f.filename ? { filename: f.filename } : {}),
      };
    if (isText(mime))
      return { type: "text", text: `--- ${f.filename ?? f.path} ---\n${readFileSync(blob.abs, "utf8")}\n--- end ---` };
  } catch {
    return null;
  }
  return null;
}

/** the seqs of the attachments that ride live in a turn over `frames`: the
 * newest `count` inlinable `media.attached` frames within the last `depth`
 * frames of the record. */
export function liveMediaSeqs(frames, { count = LIVE_MEDIA_COUNT, depth = LIVE_MEDIA_DEPTH_FRAMES } = {}) {
  const live = new Set();
  if (!(count > 0)) return live;
  for (let i = frames.length - 1; i >= 0 && i >= frames.length - depth && live.size < count; i--) {
    const f = frames[i];
    if (f?.type === "media.attached" && typeof f.seq === "number" && isInlinable(f)) live.add(f.seq);
  }
  return live;
}

/** does `model` see images/documents at all — Claude models do; a local
 * or unknown model is left with pointer lines, as before */
export function seesMedia(model) {
  return typeof model === "string" && /claude/i.test(model);
}

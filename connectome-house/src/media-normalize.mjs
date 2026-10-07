// @ts-check
/* Normalize one uploaded file for the shared store (blob-root.mjs): images
 * are re-encoded through ffmpeg (resized, metadata stripped); everything
 * else is stored as-is, under the platform's own mime and filename. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** long edge cap, px — held here so a shared image never carries print
 * resolution into anyone's context. 1024: what the old fleet's Signal
 * axon sent every model (sharp, `fit: inside`, JPEG q80) — known good, and
 * ~1.4k image tokens rather than ~3.3k at 1568. */
export const MAX_LONG_EDGE = 1024;
/** size caps BEFORE normalizing; over either refuses outright. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_OTHER_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heic",
};

const OTHER_EXT_BY_MIME = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/pdf": ".pdf",
};

/** what a mime is stored as: Signal's long-message carrier is plain text */
const MIME_ALIAS = { "text/x-signal-plain": "text/plain" };

/** ffprobe's own coded pixel formats that carry an alpha channel — a gif's
 * demuxer reports `bgra` regardless of whether transparency is actually
 * used (a conservative, format-level signal, not a per-pixel check);
 * `pal8` (indexed color) is included for the same reason: a real
 * transparency index can't be told apart from an opaque palette without
 * decoding every pixel, so it's treated as "may have alpha". */
const ALPHA_PIX_FMTS = new Set([
  "rgba",
  "bgra",
  "argb",
  "abgr",
  "ya8",
  "ya16le",
  "ya16be",
  "yuva420p",
  "yuva422p",
  "yuva444p",
  "pal8",
]);

const human = (n) => `${n} bytes`;

function extOf(filename, mime) {
  const fromName = filename && /\.[a-z0-9]{1,8}$/i.exec(String(filename))?.[0];
  if (fromName) return fromName.toLowerCase();
  return OTHER_EXT_BY_MIME[mime] ?? "";
}

/** ffprobe one media file's first video stream: {width, height, pixFmt},
 * or null on any failure — including an honest "decoded" 0x0 (ffprobe's
 * own way of saying it couldn't really read the pixels), never a throw. */
function probeImage(path) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,pix_fmt",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  try {
    const stream = JSON.parse(r.stdout)?.streams?.[0];
    if (!stream?.width || !stream.height) return null;
    return { width: stream.width, height: stream.height, pixFmt: stream.pix_fmt ?? "" };
  } catch {
    return null;
  }
}

function normalizeImage(inputBytes, sourceMime) {
  const dir = mkdtempSync(join(tmpdir(), "house-media-normalize-"));
  try {
    const inputPath = join(dir, `in${IMAGE_MIME_EXT[sourceMime] ?? ".bin"}`);
    writeFileSync(inputPath, inputBytes);

    const probe = probeImage(inputPath);
    if (!probe) return { error: "could not decode this image", code: "decode-failed" };

    const hasAlpha = ALPHA_PIX_FMTS.has(probe.pixFmt);
    const ext = hasAlpha ? ".png" : ".jpg";
    const mime = hasAlpha ? "image/png" : "image/jpeg";
    const outputPath = join(dir, `out${ext}`);
    const scale = `scale='min(${MAX_LONG_EDGE},iw)':'min(${MAX_LONG_EDGE},ih)':force_original_aspect_ratio=decrease`;
    const r = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-update",
        "1",
        "-map_metadata",
        "-1",
        "-vf",
        scale,
        ...(hasAlpha ? [] : ["-q:v", "3"]),
        outputPath,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0)
      return {
        error: `ffmpeg could not re-encode this image: ${(r.stderr ?? "").trim().slice(0, 200)}`,
        code: "decode-failed",
      };

    const outBytes = readFileSync(outputPath);
    const outProbe = probeImage(outputPath);
    return {
      bytes: outBytes,
      mime,
      ext,
      kind: "image",
      width: outProbe?.width,
      height: outProbe?.height,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Normalize one uploaded file. Never throws — every failure mode is an
 * honest `{error, code}`.
 * @param {{bytes: Uint8Array, mime: string, filename?: string}} args
 * @returns {{bytes: Buffer, mime: string, ext: string, kind: "image"|"audio"|"video"|"other", width?: number, height?: number} | {error: string, code: string}}
 */
export function normalizeMedia({ bytes, mime, filename }) {
  const raw = String(mime ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const mimeNorm = MIME_ALIAS[raw] ?? (raw || "application/octet-stream");
  const size = bytes?.length ?? 0;

  if (mimeNorm in IMAGE_MIME_EXT) {
    if (size > MAX_IMAGE_BYTES)
      return {
        error: `image is ${human(size)}, over the ${human(MAX_IMAGE_BYTES)} cap before normalizing`,
        code: "too-large",
      };
    return normalizeImage(Buffer.from(bytes), mimeNorm);
  }

  // any other file is kept verbatim, as the old fleet kept it: the
  // allowlist only names the kinds this store knows an extension for; a
  // type it doesn't (a docx, a zip, an epub) keeps its filename's own
  if (size > MAX_OTHER_BYTES)
    return {
      error: `file is ${human(size)}, over the ${human(MAX_OTHER_BYTES)} cap`,
      code: "too-large",
    };
  const kind = mimeNorm.startsWith("audio/") ? "audio" : mimeNorm.startsWith("video/") ? "video" : "other";
  return { bytes: Buffer.from(bytes), mime: mimeNorm, ext: extOf(filename, mimeNorm), kind };
}

// @ts-check
/* connectome-house/src/mcpl/media-out.mjs — a room's own `media.attached`
 * frame → the shape one platform's send tool wants. Pure resolution +
 * shaping; speak.mjs does the actual tools/call and the delivery ledger.
 *
 * Ported from a private deployment (2026-09-17): the source's own
 * resolver (serve-media.mjs) understood several product-specific media
 * roots (a corpus's own originals, a walker's rendered output) alongside
 * the shared blob store. This port resolves only `blob/<sha>` addresses
 * — the shared, content-addressed store (blob-root.mjs) media a HUMAN
 * shared into a room actually lives in; a deployment with its own other
 * media roots can widen `resolveOutboundMedia` below. Over a platform's
 * own outbound ceiling (named constants, never inlined), the caller
 * sends a text line with the address instead — this module only says
 * which. */
import { readFileSync, statSync } from "node:fs";
import { resolveBlob } from "../blob-root.mjs";

/** Discord's default (non-boosted-server) upload ceiling; signal-cli-rest-
 * api's own documented attachment ceiling. Conservative, named, so a
 * keeper override is one constant away rather than a buried literal. */
export const DISCORD_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SIGNAL_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
const LIMITS = { discord: DISCORD_ATTACHMENT_MAX_BYTES, signal: SIGNAL_ATTACHMENT_MAX_BYTES };

/** @param {string} platform @returns {number} */
export function maxBytesFor(platform) {
  return LIMITS[platform] ?? DISCORD_ATTACHMENT_MAX_BYTES;
}

/** does `platform` have a known outbound attachment shape (toolArgsFor)?
 * An unregistered/mock platform gets an honest text fallback instead of a
 * call built on a guessed schema. @param {string} platform */
export function supportsAttachments(platform) {
  return platform === "discord" || platform === "signal";
}

/** @typedef {{ok: true, abs: string, mime: string, bytes: number, filename: string|null}
 *   | {ok: false, reason: "not-found"|"too-large"|"unsupported", bytes?: number}} Resolved */

/** resolve a `media.attached` frame's address to bytes on disk, honestly —
 * never found (denied, or the address doesn't exist here), too large for
 * this platform, or a platform this module doesn't know how to shape.
 * @param {{path: string, filename?: string|null}} f @param {string} platform
 * @returns {Resolved} */
export function resolveOutboundMedia(f, platform) {
  if (!supportsAttachments(platform)) return { ok: false, reason: "unsupported" };
  const sha = String(f.path ?? "").startsWith("blob/") ? f.path.slice("blob/".length) : null;
  const resolved = sha ? resolveBlob(sha) : null;
  if (!resolved) return { ok: false, reason: "not-found" };
  const bytes = statSync(resolved.abs).size;
  if (bytes > maxBytesFor(platform)) return { ok: false, reason: "too-large", bytes };
  return {
    ok: true,
    abs: resolved.abs,
    mime: resolved.sidecar.mime ?? "application/octet-stream",
    bytes,
    filename: f.filename ?? null,
  };
}

/** the tool args a platform's send/reply tool wants for one resolved
 * attachment — discord-mcpl's `files` (host filesystem paths,
 * tools.ts:16-35) vs signal-mcpl's `attachments` (inline base64,
 * manifest.mjs's TOOLS). Called only when `resolveOutboundMedia` returned
 * `ok: true` for a supported platform.
 * @param {string} platform @param {{abs: string, mime: string, filename: string|null}} r
 * @returns {Record<string, unknown>} */
export function toolArgsFor(platform, r) {
  if (platform === "discord")
    return { files: [{ path: r.abs, ...(r.filename ? { name: r.filename } : {}) }] };
  return {
    attachments: [
      { data: readFileSync(r.abs).toString("base64"), mimeType: r.mime, filename: r.filename },
    ],
  };
}

/** a human-readable size, for an honest text fallback line.
 * @param {number} n @returns {string} */
export function humanBytes(n) {
  return n < 1024
    ? `${n}B`
    : n < 1048576
      ? `${(n / 1024).toFixed(0)}KB`
      : `${(n / 1048576).toFixed(1)}MB`;
}

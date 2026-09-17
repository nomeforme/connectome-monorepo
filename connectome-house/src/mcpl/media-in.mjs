// @ts-check
/* harness/src/mcpl/media-in.mjs — a platform message's inline attachments
 * (adapter.blobs(msg): base64 image blocks the seat already fetched) into
 * the house-wide shared store, so they ride the SAME roomInput() call as
 * the message's text (platform-reach R2f, contract 3) rather than a
 * separate house `media.attached` frame — the child records that frame
 * once, from the attachments it receives (contract 4).
 *
 * `storeSharedMedia` (media-share.mjs, builder M's contract, merged) is
 * imported dynamically all the same — a caller may also inject it (tests).
 * `filename` is honestly null when the platform's own block carries none
 * (discord-mcpl's image blocks never do; normalize.mjs/adapters.mjs carry
 * signal-mcpl's own filename through when it does). */

/** @typedef {{path: string, kind: string, mime: string, filename: string|null}} StoredAttachment */

/** @param {{bytes: Buffer, mime: string, filename?: string|null}[]} blobs
 * @param {{platform: string, runId: string, log?: (line: string) => void,
 *   storeSharedMedia?: (args: object) => Promise<any>|any}} args
 * @returns {Promise<StoredAttachment[]>} the ones that stored cleanly —
 *   anything refused (bad mime, too large, undecodable) or dropped because
 *   the contract isn't wired up yet is logged once and left out; the
 *   caller still inputs the message's text either way. */
export async function storeInboundAttachments(
  blobs,
  { platform, runId, log = () => {}, storeSharedMedia },
) {
  if (!blobs.length) return [];
  const store = storeSharedMedia ?? (await import("../media-share.mjs")).storeSharedMedia;
  if (typeof store !== "function") {
    log(`storeSharedMedia is not wired up yet — ${blobs.length} inbound attachment(s) dropped`);
    return [];
  }
  const out = [];
  for (const { bytes, mime, filename } of blobs) {
    let stored;
    try {
      stored = await store({
        bytes,
        contentType: mime,
        filename: filename ?? null,
        origin: { via: platform, room: runId },
        runId,
      });
    } catch (e) {
      log(`storeSharedMedia threw on an inbound attachment: ${e.message}`);
      continue;
    }
    if (!stored || stored.error) {
      log(
        `inbound attachment dropped (${stored?.code ?? "error"}): ${stored?.error ?? "no result"}`,
      );
      continue;
    }
    out.push({
      path: stored.path,
      kind: stored.kind,
      mime: stored.mime,
      filename: stored.filename ?? null,
    });
  }
  return out;
}

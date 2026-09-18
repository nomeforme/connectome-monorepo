// @ts-check
/* connectome-house/src/serve-media-upload.mjs — POST /api/media/upload
 * {?run=<roomId>&name=<filename>}: an HTTP client's own ingress into the
 * shared-media store (media-share.mjs's storeSharedMedia), the same
 * normalization every platform attachment already goes through
 * (media-normalize.mjs). Signed in only; naming `run` requires the caller
 * be allowed to TOUCH that room (serve-identity.mjs's mayTouch — reading
 * is not enough to attach media into it). No `run` (no room open yet, or
 * a client composing a message before a room exists) stores a pending
 * blob, referenceable later once a room does (serve-attachments.mjs's
 * `attachAllToRun`, called from `roomInput`).
 *
 * Ported from a private deployment's serve-media-upload.mjs — needed by
 * this port for the same reason the source built it: a non-platform HTTP
 * caller (the web MCPL, once written — docs/harness-port/03-house-
 * design.md §4) has no platform attachment to normalize FROM; this route
 * is its only door in. Trimmed: the source's own 404/403 messages named
 * a rich "conversation" concept this port calls a room instead.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { MAX_IMAGE_BYTES, MAX_OTHER_BYTES } from "./media-normalize.mjs";
import { storeSharedMedia } from "./media-share.mjs";
import { RUNS } from "./serve-paths.mjs";
import { json } from "./serve-http.mjs";
import { mayTouch, scopeOfDir, whoAmI } from "./serve-identity.mjs";

const capFor = (contentType) =>
  contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_OTHER_BYTES;

/** read the raw request body, stopping (never buffering past `capBytes`)
 * the instant it's exceeded — a large upload can't hold the process's
 * memory hostage waiting for `end`. Does NOT destroy the socket itself:
 * the caller must write its error response before destroying the
 * request, or the client sees a bare connection reset instead of the
 * 413 (respond-then-destroy; the reverse loses the response). */
function readBodyCapped(req, capBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      total += chunk.length;
      if (total > capBytes) {
        over = true;
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!over) reject(e);
    });
  });
}

/** @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url */
export async function handleMediaUpload(req, res, url) {
  const who = whoAmI(req);
  if (!who.authed) return json(res, 401, { error: "sign in to upload media" });

  const runId = String(url.searchParams.get("run") ?? "").trim();
  const filename = String(url.searchParams.get("name") ?? "").trim() || undefined;
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (runId) {
    const runsResolved = resolve(RUNS);
    const runDir = resolve(RUNS, runId);
    if (!runDir.startsWith(runsResolved + sep) || !existsSync(runDir))
      return json(res, 404, { error: "no such room" });
    if (!mayTouch(who, scopeOfDir(runDir)))
      return json(res, 403, { error: "you may not attach media to this room" });
  }

  const cap = capFor(contentType);
  let bytes;
  try {
    bytes = await readBodyCapped(req, cap);
  } catch (e) {
    if (e.tooLarge) {
      json(res, 413, { error: `body exceeds the ${cap}-byte cap`, code: "too-large" });
      req.destroy(); // AFTER the response — destroying first drops it (see readBodyCapped)
      return;
    }
    return json(res, 400, { error: "could not read the upload body" });
  }
  if (!bytes.length) return json(res, 400, { error: "empty upload body" });

  const result = storeSharedMedia({
    bytes,
    contentType,
    filename,
    origin: runId ? { via: "app", room: runId } : { via: "app" },
    runId: runId || undefined,
    uploader: who.handle,
  });
  if (result.error) {
    const status = result.code === "too-large" ? 413 : result.code === "mime-refused" ? 415 : 422;
    return json(res, status, result);
  }
  return json(res, 200, result);
}

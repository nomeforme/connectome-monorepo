// @ts-check
/* connectome-house/src/blob-root.mjs — the house-wide, content-addressed
 * home for shared media a HUMAN shares INTO a room (a Discord image, a
 * Signal photo) — never a specific being's own credentials or a
 * product-layer archive's originals; those, if a deployment has any, live
 * behind the covenant's own optional `archive` mount (house-config.mjs)
 * instead. Bytes are stored once, addressed by their own sha256,
 * referenced from any number of rooms — the same bytes stored once but
 * remembered N ways, extended from speech to attachments.
 *
 *   <root>/blobs/<xx>/<sha256>.<ext>   the bytes (xx = the sha's own first
 *                                      two hex chars — a git-object-style
 *                                      shard)
 *   <root>/blobs/<xx>/<sha256>.json    sidecar: {sha256, bytes, mime, ext,
 *                                      created_t, origin}
 *   <root>/refs/<sha256>.jsonl         append-only {run, seq, t} lines —
 *                                      every room that has ever referenced
 *                                      this blob (the visibility gate's
 *                                      own index: "may this viewer see AT
 *                                      LEast one room that references it")
 *
 * Root: HOUSE_BLOB_ROOT if set, else <package>/blobs (gitignored —
 * box-local). `blobRoot()` reads the env var fresh on every call, never
 * once at module-eval time — a test fixture's root must never race this
 * module's own import order.
 *
 * Living archive, never deleted: putBlob never overwrites or removes an
 * existing sha's bytes or sidecar, even if called again with different
 * metadata — the FIRST write is authoritative; a later call is a no-op
 * that returns the existing address.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { PACKAGE_ROOT } from "./serve-paths.mjs";

const SHA_RE = /^[0-9a-f]{64}$/;

/** does `sha` look like a real sha256 hex digest? Defends every reader
 * below against path traversal and garbage ids, same discipline as VEIL's
 * own isValidBlobId (blob-store.ts:274-276). */
export function isValidSha(sha) {
  return typeof sha === "string" && SHA_RE.test(sha);
}

/** the store's root dir. HOUSE_BLOB_ROOT if set (tests: a mktemp -d
 * sandbox), else <package>/blobs. Read fresh every call — never cached at
 * module-eval time. */
export function blobRoot() {
  return process.env.HOUSE_BLOB_ROOT || join(PACKAGE_ROOT, "blobs");
}

function shardDir(root, sha) {
  return join(root, "blobs", sha.slice(0, 2));
}

/** normalize an extension to VEIL's `.jpg`-with-dot shape (this codebase's
 * own convention — machine-manifest.mjs's extOf does the same); "" (no
 * extension) is an honest, allowed shape for a blob of unknown type. */
function normalizeExt(ext) {
  const e = String(ext ?? "").trim();
  if (!e) return "";
  return (e.startsWith(".") ? e : `.${e}`).toLowerCase();
}

/** a blob's sidecar metadata, or null if it doesn't exist / doesn't parse.
 * The one source of truth for a blob's real on-disk extension — a data
 * file's name is only ever derived FROM the sidecar, never guessed. */
export function readBlobSidecar(sha) {
  if (!isValidSha(sha)) return null;
  const p = join(shardDir(blobRoot(), sha), `${sha}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // a truncated/corrupt sidecar is honest absence, never a throw
  }
}

/** the blob's real file path AND its sidecar in one read, or null if the
 * sha is malformed, unknown, or its data file is missing even though a
 * sidecar exists (an orphaned sidecar — a dangling pointer is not this
 * function's problem to paper over).
 * @returns {{abs: string, sidecar: {mime?: string, ext?: string, bytes?: number}}|null} */
export function resolveBlob(sha) {
  const sidecar = readBlobSidecar(sha);
  if (!sidecar) return null;
  const abs = join(shardDir(blobRoot(), sha), `${sha}${sidecar.ext ?? ""}`);
  return existsSync(abs) ? { abs, sidecar } : null;
}

/** the blob's real file path, or null — `resolveBlob` without the sidecar */
export function getBlobPath(sha) {
  return resolveBlob(sha)?.abs ?? null;
}

/** does this sha already live in the store (bytes AND sidecar, not one
 * without the other)? */
export function hasBlob(sha) {
  return getBlobPath(sha) !== null;
}

/**
 * Store `bytes` under their own sha256. Idempotent: a sha already in the
 * store is a no-op — its existing bytes and sidecar are never touched,
 * even if this call's `meta` disagrees with what's on record (the first
 * write is authoritative, matching VEIL's own "same content -> same id ->
 * free dedup" and this store's living-archive rule).
 *
 * Crash-safe: bytes and sidecar are each written atomically (atomic-write.mjs:
 * tmp + rename, tmp removed on failure), data before sidecar — a data file
 * with no sidecar yet is a recoverable in-flight write (the next putBlob of
 * the same sha rewrites both), the reverse is not.
 *
 * @param {Uint8Array} bytes
 * @param {{mime?: string, ext?: string, origin?: object}} [meta]
 * @returns {{sha: string, path: string|null, existed: boolean}}
 */
export function putBlob(bytes, meta = {}) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const root = blobRoot();
  const dir = shardDir(root, sha);
  const existing = readBlobSidecar(sha);
  if (existing) {
    const abs = join(dir, `${sha}${existing.ext ?? ""}`);
    return { sha, path: existsSync(abs) ? abs : null, existed: true };
  }
  mkdirSync(dir, { recursive: true });
  const ext = normalizeExt(meta.ext);
  const dataPath = join(dir, `${sha}${ext}`);
  const sidecarPath = join(dir, `${sha}.json`);
  // two writers racing the same new sha (no cross-process lock) both rename
  // identical bytes into place — a losing writer corrupts nothing.
  const sidecar = {
    sha256: sha,
    bytes: bytes.length,
    mime: meta.mime ?? "application/octet-stream",
    ext,
    created_t: new Date().toISOString(),
    origin: meta.origin ?? {},
  };
  atomicWriteFileSync(dataPath, bytes);
  atomicWriteFileSync(sidecarPath, JSON.stringify(sidecar));
  return { sha, path: dataPath, existed: false };
}

/** record that room `run` (at frame `seq`) references blob `sha` — the
 * reverse index the visibility gate reads. Append-only: every share is
 * its own line, never deduplicated or merged (a blob referenced by the
 * same room twice, at two different seqs, is two genuine facts). */
export function addRef(sha, { run, seq }) {
  if (!isValidSha(sha)) throw new Error(`addRef: not a sha256: ${JSON.stringify(sha)}`);
  const dir = join(blobRoot(), "refs");
  mkdirSync(dir, { recursive: true });
  const line = { run, seq, t: new Date().toISOString() };
  appendFileSync(join(dir, `${sha}.jsonl`), `${JSON.stringify(line)}\n`);
  return line;
}

/** record that `uploader` (a handle) holds blob `sha` pending its first
 * room — same reverse index as `addRef`, one line, `run:null` +
 * `pending:true` + `uploader`. A room's later real `addRef` doesn't
 * remove this line; it's history, not a swapped state. */
export function addPendingRef(sha, { uploader }) {
  if (!isValidSha(sha)) throw new Error(`addPendingRef: not a sha256: ${JSON.stringify(sha)}`);
  const dir = join(blobRoot(), "refs");
  mkdirSync(dir, { recursive: true });
  const line = { run: null, seq: null, t: new Date().toISOString(), pending: true, uploader };
  appendFileSync(join(dir, `${sha}.jsonl`), `${JSON.stringify(line)}\n`);
  return line;
}

/** every room that has ever referenced `sha`, oldest first. Honest empty
 * array for an unknown sha or one nothing has referenced yet — never a
 * throw. A corrupt line is skipped, not fatal to the rest of the file. */
export function refsOf(sha) {
  if (!isValidSha(sha)) return [];
  const p = join(blobRoot(), "refs", `${sha}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

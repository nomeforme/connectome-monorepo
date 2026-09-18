// @ts-check
/* connectome-history-import/src/write.mjs — a built room (records.mjs) onto
 * disk, through the house's own writers: frames + chronicle via
 * connectome-house's `trace.mjs`'s `openTrace` (the same seq/blob
 * discipline a live room worker has), bytes into the house blob root via
 * `blob-root.mjs`'s `putBlob` + `addRef` (VEIL's blobId IS the sha256 of
 * the same bytes — verified, never assumed), and every frame checked
 * against the house's closed Frame schema (frame-schema.mjs) BEFORE it
 * lands: an importer that fails open would be the same trap the house's
 * own `frames-io.mjs` deliberately accepts for a LIVE frame (it warns,
 * never blocks) in a new coat — history restoration gets no such mercy,
 * since nothing downstream can ever re-derive a bad frame from the source
 * again.
 *
 * A forked room (a substream) gets its `forkedFrom` pointer on its OWN
 * `room.mounted` frame (records.mjs); this module additionally appends a
 * `branch.created` marker to the PARENT's already-written record, using
 * the house's own `appendHouseFrame` (frames-io.mjs) — the same "append a
 * house-authored fact to a room that isn't live right now" path a rested
 * room's own bookkeeping uses. Both ends of the fork carry the fact, never
 * just one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { Frame } from "connectome-house/src/frame-schema.mjs";
import { openTrace } from "connectome-house/src/trace.mjs";
import { addRef, putBlob } from "connectome-house/src/blob-root.mjs";
import { appendHouseFrame } from "connectome-house/src/frames-io.mjs";

const ajv = new Ajv({ strict: false });
const validFrame = ajv.compile(Frame);

/** the VEIL blob's bytes + sidecar for `blobId`, or null when the store
 * doesn't hold it (a blob older than the kept history, or never synced). */
export function readVeilBlob(stateDir, blobId) {
  if (!/^[0-9a-f]{64}$/.test(String(blobId))) return null;
  const dir = join(stateDir, "blobs", blobId.slice(0, 2));
  const bin = join(dir, `${blobId}.bin`);
  if (!existsSync(bin)) return null;
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, `${blobId}.json`), "utf8"));
  } catch {
    /* a missing sidecar: the bytes still say what they are by sha */
  }
  return {
    bytes: readFileSync(bin),
    mime: meta.contentType ?? null,
    filename: meta.filename ?? "",
  };
}

const extOfMime = (mime) => {
  const m = String(mime ?? "")
    .split(";")[0]
    .trim();
  const known = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return known[m] ?? "";
};

/** bytes for one attachment (VEIL blob store, or inline base64 on a bot's
 * own speech attachment) into the house blob root + its ref. A blob whose
 * bytes can't be found still gets a `media.attached` frame (the schema
 * requires `sha`, so the original VEIL blobId stands in for it) — the
 * frame's own `missing: true` says honestly that the bytes never arrived. */
function resolveAttachment(stateDir, blob, ref) {
  let bytes = null;
  let mime = blob.mime;
  if (blob.blobId) {
    const v = readVeilBlob(stateDir, blob.blobId);
    if (v) {
      bytes = v.bytes;
      mime = v.mime ?? mime;
    }
  } else if (blob.data) {
    try {
      bytes = Buffer.from(blob.data, "base64");
    } catch {
      bytes = null;
    }
  }
  if (!bytes) return { outcome: "missing", sha: blob.blobId ?? null };
  const origin = { kind: "import", source: "veil", platform: ref.platform, room: ref.run };
  const put = putBlob(bytes, {
    mime: mime ?? "application/octet-stream",
    ext: extOfMime(mime),
    origin,
  });
  addRef(put.sha, { run: ref.run, seq: ref.seq });
  const mismatch = blob.blobId && put.sha !== blob.blobId;
  return { outcome: mismatch ? "shaMismatch" : put.existed ? "existed" : "stored", sha: put.sha };
}

/**
 * @param {{
 *   runsDir: string, stateDir: string,
 *   room: ReturnType<import("./records.mjs").buildRoom>,
 *   dryRun?: boolean,
 * }} args
 * @returns {Promise<{id: string, runDir: string, frames: number, blobs: {stored: number, existed: number, missing: number, shaMismatch: number}, substrate: string}>}
 */
export async function writeRoom({ runsDir, stateDir, room, dryRun = false }) {
  const runDir = join(runsDir, room.id);
  if (existsSync(join(runDir, "frames.jsonl")))
    throw new Error(`refusing to write over an existing record: ${room.id}`);
  const blobs = { stored: 0, existed: 0, missing: 0, shaMismatch: 0 };
  // validate everything first — a room is written whole or not at all
  const prepared = [];
  for (const f of room.frames) {
    const { seq, _blob, _text, ...rest } = f;
    prepared.push({ seq, rest, _blob, _text });
  }
  if (dryRun)
    return { id: room.id, runDir, frames: room.frames.length + 1, blobs, substrate: "dry-run" };

  mkdirSync(runDir, { recursive: true });
  const trace = await openTrace(runDir);
  // the FIRST frame is always room.mounted, built before this trace was
  // opened (records.mjs doesn't know chronicle-vs-jsonl-fallback yet) —
  // patch its `substrate` to what actually opened, so the record never
  // claims a store it isn't using.
  if (prepared[0]) prepared[0].rest.substrate = trace.substrate;
  for (const p of prepared) {
    const data = { ...p.rest };
    if (p._blob) {
      const resolved = resolveAttachment(stateDir, p._blob, {
        run: room.id,
        seq: p.seq,
        platform: room.cls.room.platform,
      });
      blobs[resolved.outcome] += 1;
      data.path = resolved.sha ? `blob/${resolved.sha}` : "blob/unknown";
      data.sha = resolved.sha ?? "unknown";
      if (resolved.outcome === "missing") data.missing = true;
    }
    if (typeof p._text === "string") Object.assign(data, trace.result(p._text));
    const { t, type, ...fields } = data;
    const check = { seq: p.seq, t, type, ...fields };
    if (!validFrame(check)) {
      trace.close({}, { kind: "rested" });
      throw new Error(
        `${room.id} frame ${p.seq} (${type}) fails the Frame schema: ${ajv.errorsText(validFrame.errors)}`,
      );
    }
    const written = trace.frame(type, { t, ...fields });
    if (written.seq !== p.seq)
      throw new Error(`${room.id}: seq drift at ${p.seq} (trace wrote ${written.seq})`);
  }
  const closing = { ...room.closing };
  const closingCheck = { seq: prepared.length, ...closing };
  if (!validFrame(closingCheck))
    throw new Error(
      `${room.id} closing frame fails the Frame schema: ${ajv.errorsText(validFrame.errors)}`,
    );
  const { type: closingType, ...closingFields } = closing;
  trace.close(closingFields, { kind: closingType });
  writeFileSync(join(runDir, "class.json"), JSON.stringify(room.cls, null, 2));
  writeFileSync(join(runDir, "run.json"), JSON.stringify(room.run, null, 2));
  if (room.externalLines.length)
    appendFileSync(
      join(runDir, "external.jsonl"),
      `${room.externalLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  return { id: room.id, runDir, frames: prepared.length + 1, blobs, substrate: trace.substrate };
}

/** marks the PARENT of a just-written forked room with a `branch.created`
 * frame naming the child — the other half of records.mjs's `forkedFrom`
 * pointer on the child's own `room.mounted` frame. The parent room is
 * already at rest (this importer never runs against a live room), so this
 * is exactly `appendHouseFrame`'s own case: one fractional-seq append,
 * never colliding with a later live child's integer counter. A parent
 * whose frames.jsonl is missing (shouldn't happen — it was just written by
 * this same importer run, or already existed on disk) is a no-op, never a
 * throw: the child's own `forkedFrom` pointer still carries the fact.
 * @param {string} runsDir @param {string} parentId @param {string} childId */
export function markBranchOnParent(runsDir, parentId, childId) {
  const parentFrames = join(runsDir, parentId, "frames.jsonl");
  appendHouseFrame(parentFrames, { type: "branch.created", id: childId });
}

/** appends a LATER slice's frames to a room already on disk
 * (docs/harness-port/04-history-restore.md §6, slice.mjs) — the same
 * schema-checked, blob-resolving write as `writeRoom`, but resuming the
 * trace (`openTrace(..., {resume: true})`) instead of minting a fresh one,
 * and merging into the existing class.json/run.json rather than replacing
 * them. Refuses a room with no record yet; the caller (slice.mjs) already
 * refused an import lock and a not-at-rest room before this is called.
 * @param {{runsDir: string, stateDir: string, runId: string,
 *   frames: Array<{t: string, type: string, [k: string]: any, _blob?: object, _text?: string}>,
 *   closing: {t: string, type: string, [k: string]: any},
 *   clsPatch: (cls: object) => object, runPatch: (run: object) => object,
 *   externalLines: Array<object>,
 * }} args
 * @returns {Promise<{runDir: string, frames: number, blobs: object, substrate: string}>}
 */
export async function appendSlice({
  runsDir,
  stateDir,
  runId,
  frames,
  closing,
  clsPatch,
  runPatch,
  externalLines,
}) {
  const runDir = join(runsDir, runId);
  if (!existsSync(join(runDir, "frames.jsonl")))
    throw new Error(`appendSlice: no existing record for ${runId}`);
  const blobs = { stored: 0, existed: 0, missing: 0, shaMismatch: 0 };
  const cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  const platform = cls.room?.platform ?? null;
  const trace = await openTrace(runDir, { resume: true });
  let written = 0;
  for (const f of frames) {
    const { _blob, _text, ...rest } = f;
    const data = { ...rest };
    if (_blob) {
      const resolved = resolveAttachment(stateDir, _blob, { run: runId, seq: written, platform });
      blobs[resolved.outcome] += 1;
      data.path = resolved.sha ? `blob/${resolved.sha}` : "blob/unknown";
      data.sha = resolved.sha ?? "unknown";
      if (resolved.outcome === "missing") data.missing = true;
    }
    if (typeof _text === "string") Object.assign(data, trace.result(_text));
    const { t, type, ...fields } = data;
    const check = { seq: written, t, type, ...fields };
    if (!validFrame(check)) {
      trace.close({}, { kind: "rested" });
      throw new Error(
        `${runId} slice frame ${written} (${type}) fails the Frame schema: ${ajv.errorsText(validFrame.errors)}`,
      );
    }
    trace.frame(type, { t, ...fields });
    written += 1;
  }
  const { type: closingType, ...closingFields } = closing;
  trace.close(closingFields, { kind: closingType });
  writeFileSync(join(runDir, "class.json"), JSON.stringify(clsPatch(cls), null, 2));
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify(runPatch(run), null, 2));
  if (externalLines.length)
    appendFileSync(
      join(runDir, "external.jsonl"),
      `${externalLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  return { runDir, frames: written, blobs, substrate: trace.substrate };
}

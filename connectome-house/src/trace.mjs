/* The world-centric chronicle trace: records the world of the walk, not
 * an agent's chat log (research/harness-integration-plan.md §4). One
 * append-log state, `frames` — an ordered, immutable history of
 * world-events (world.mounted, question.asked, reach, reach.result,
 * speech, note.filed, dissolved, rested, world.remounted, plus
 * auto.state/leave.gate/fork.narrated/error/aborted — full union in
 * app/viz/src/contracts/frames.ts).
 *
 * chronicle (@animalabs/chronicle, Rust) is the store of record; if its
 * native binding is unavailable, this degrades honestly to a plain JSONL
 * frame log with the same schema. */
import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { resolveBlobInLineage } from "./lineage.mjs";

const BLOB_THRESHOLD = 4096; // bytes; larger reach-results are content-addressed

/* decode a chronicle blob file, per the store's own layout
 * (repos/antra/chronicle/src/blobs/storage.rs): "BLB\0" magic, u8 version,
 * u16 LE mime-length, mime, u64 LE payload length, payload, u32 LE crc32.
 * Unknown layouts degrade to a tail-slice heuristic; unreadable = null. */
function decodeBlobFile(path, bytes) {
  try {
    const buf = readFileSync(path);
    if (buf.length >= 15 && buf.subarray(0, 4).equals(Buffer.from([0x42, 0x4c, 0x42, 0x00]))) {
      const mimeLen = buf.readUInt16LE(5);
      const off = 7 + mimeLen;
      const len = Number(buf.readBigUInt64LE(off));
      return buf.subarray(off + 8, off + 8 + len).toString("utf8");
    }
    return typeof bytes === "number"
      ? buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8")
      : buf.toString("utf8");
  } catch {
    return null;
  }
}

/* read a chronicle blob's payload by hash, resolved across `runDir`'s own
 * lineage (lineage.mjs): a fork/Return never copies blob files, so a blob
 * an ancestor's turn produced is read from that ancestor's own store. */
export function readBlobText(runDir, sha, bytes) {
  const { path } = resolveBlobInLineage(runDir, sha);
  return path ? decodeBlobFile(path, bytes) : null;
}

/* decode a frame's result payload — trace.result()'s inverse. Resolution
 * order mirrors how result() encodes: inline text, else the chronicle
 * blob, else the jsonl-fallback blob file, else the degraded preview — the
 * preview says so when the blob is unreachable because an ancestor record
 * is gone, so that reads differently from an always-preview frame. Frames
 * that never go through result() (question.asked, fork.narrated,
 * threshold.receipt) carry their full text directly on `.text` instead —
 * a last, non-degraded fallback, checked before the truncated preview. */
export function frameText(frame, runDir) {
  if (typeof frame.inline === "string") return frame.inline;
  if (typeof frame.blob === "string") {
    const { path, missingAncestor } = resolveBlobInLineage(runDir, frame.blob);
    const text = path ? decodeBlobFile(path, frame.bytes) : null;
    if (text != null) return text;
    if (missingAncestor)
      return `${frame.preview ?? ""}\n[… ancestor record ${missingAncestor} is gone; the full result is no longer reachable]`;
  }
  if (typeof frame.file === "string") {
    try {
      return readFileSync(join(runDir, frame.file), "utf8");
    } catch {
      /* fall through to preview */
    }
  }
  if (typeof frame.text === "string") return frame.text;
  return frame.preview ?? "";
}

export async function openTrace(runDir, { resume = false } = {}) {
  mkdirSync(runDir, { recursive: true });
  const jsonlPath = join(runDir, "frames.jsonl");
  /* resume: the run dir already holds a frame prefix (a fork's copy of its
   * parent's frames). Opens in append mode — seq continues from the
   * prefix tail, never restarts at 0 (docs/research/loom-design.md §3.3) —
   * and the parsed prefix rides back so walk.mjs can rebuild history
   * without a second read. */
  let prefix = [];
  if (resume) {
    if (!existsSync(jsonlPath))
      throw new Error(`--resume: no frames.jsonl in ${runDir} — a fork without a prefix is a bug`);
    prefix = readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // a truncated line is honest absence, never a crash
        }
      })
      .filter(Boolean);
    if (prefix.length === 0)
      throw new Error(`--resume: frames.jsonl in ${runDir} holds no parseable frames`);
  }
  let store = null;
  let substrate = "jsonl-fallback";
  /* fork blob seed — now a defensive fallback, not the common path: before
   * findBlobAcrossLineage (lineage.mjs) existed, serve's fork endpoint
   * copied the parent's referenced blobs into chronicle/blobs/ before this
   * spawns, so a fresh fork/Return dir could already hold seeded blob files
   * with no store (chronicle's openOrCreate refuses exactly that shape).
   * Forks/Returns no longer pre-seed (blobs resolve by lineage instead), so
   * this branch should rarely fire; it stays for any dir carrying an old
   * pre-seeded copy, or a manually restored one. Seeded-but-storeless is
   * set aside, a fresh store created, then the seed merged back in; on
   * failure the seed is restored so hash paths still resolve under JSONL. */
  const chronDir = join(runDir, "chronicle");
  let seed = null;
  if (resume && existsSync(join(chronDir, "blobs")) && !existsSync(join(chronDir, "MANIFEST"))) {
    seed = join(runDir, "chronicle.seed");
    renameSync(chronDir, seed);
  }
  try {
    const { JsStore } = await import("@animalabs/chronicle");
    store = JsStore.openOrCreate({ path: chronDir, blobCacheSize: 64 });
    store.registerState({
      id: "frames",
      strategy: "append_log",
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 500,
    });
    substrate = "chronicle";
    if (seed) {
      for (const shard of readdirSync(join(seed, "blobs"))) {
        mkdirSync(join(chronDir, "blobs", shard), { recursive: true });
        for (const f of readdirSync(join(seed, "blobs", shard)))
          renameSync(join(seed, "blobs", shard, f), join(chronDir, "blobs", shard, f));
      }
      rmSync(seed, { recursive: true, force: true });
      seed = null;
    }
  } catch (e) {
    console.error(`[trace] chronicle unavailable (${e.message}); falling back to JSONL frame log`);
    if (seed) {
      // restore the seed where readers expect it (chronicle/blobs/<sha>)
      rmSync(chronDir, { recursive: true, force: true });
      renameSync(seed, chronDir);
      seed = null;
    }
  }
  // Math.floor, not a bare +1: a server-side house-frame append can land a
  // fractional seq (serve-inbox.mjs's +0.5 fallback) — flooring first keeps
  // every fresh seq this process mints an integer.
  const lastFrame = prefix.length ? prefix[prefix.length - 1] : null;
  let seq = lastFrame ? Math.floor(lastFrame.seq ?? prefix.length - 1) + 1 : 0;

  const frame = (type, data = {}) => {
    const f = { seq: seq++, t: new Date().toISOString(), type, ...data };
    if (store) store.appendToStateJson("frames", f);
    appendFileSync(jsonlPath, `${JSON.stringify(f)}\n`); // keeper-side convenience dump, always written
    return f;
  };

  const blob = (text, mime = "text/plain") => {
    if (store)
      return { blob: store.storeBlob(Buffer.from(text), mime), bytes: Buffer.byteLength(text) };
    const name = `blob-${seq}-${Date.now()}.txt`;
    writeFileSync(join(runDir, name), text);
    return { file: name, bytes: Buffer.byteLength(text) };
  };

  /* a reach-result: inline if small, content-addressed if large — either way the
     frame carries an honest preview so the trace reads without dereferencing */
  const result = (payload) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (Buffer.byteLength(text) <= BLOB_THRESHOLD) return { inline: text };
    return { ...blob(text), preview: text.slice(0, 400) };
  };

  /* end-of-process isn't always end-of-conversation
   * (docs/synthesis/users-and-continuity.md §5): kind "dissolved" (default)
   * seals the walk; "rested" parks it for a later --resume in the same run
   * dir. serve.mjs branches its dissolve pipeline on which one it finds. */
  const close = (summary = {}, { kind = "dissolved" } = {}) => {
    frame(kind, summary);
    if (store) {
      store.sync();
      store.close();
    }
  };

  return { frame, blob, result, close, substrate, jsonlPath, prefix };
}

/** One membrane ToolCall -> ToolResult, traced as `reach`/`reach.result`
 * frames on `ctx.trace` (an `openTrace()` return value). `produce()`
 * returns `{content, recorded?, extra?}` (recorded defaults to content
 * when it's a string, else a placeholder), sync or async; a throw/
 * rejection records ok:false and returns isError:true. Shared shape for
 * any being-side tool that wants its calls to land in the room's own
 * record as reaches, not silently. */
export function traceReach(
  ctx,
  call,
  produce,
  { errorContent = (e) => `error: ${e.message}` } = {},
) {
  ctx?.trace.frame("reach", { tool: call.name, input: call.input, callId: call.id });
  const settle = (out) => {
    const recorded =
      out.recorded ?? (typeof out.content === "string" ? out.content : "(structured result)");
    ctx?.trace.frame("reach.result", {
      callId: call.id,
      ok: true,
      ...(ctx ? ctx.trace.result(recorded) : {}),
      ...(out.extra ?? {}),
    });
    return { toolUseId: call.id, content: out.content };
  };
  const fail = (e) => {
    ctx?.trace.frame("reach.result", { callId: call.id, ok: false, error: e.message });
    return { toolUseId: call.id, content: errorContent(e), isError: true };
  };
  try {
    const out = produce();
    return out && typeof out.then === "function" ? out.then(settle, fail) : settle(out);
  } catch (e) {
    return fail(e);
  }
}

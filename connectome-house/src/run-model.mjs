// @ts-check
/* Fallback model id for a run whose run.json isn't written yet (only
 * written at dissolve) — reads the seq-0 world.mounted frame's
 * harness.model directly, without loading the rest of frames.jsonl.
 * Own module (not inlined in serve.mjs) so it's unit-testable: serve.mjs
 * starts a live HTTP server as a side effect of import. */
import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";

// bounded head-read: frames.jsonl can grow large over a long walk, and this
// only ever needs byte 0 through the first line's newline.
const HEAD_BYTES = 4096;

/** The model recorded in a run dir's seq-0 `world.mounted` frame, read
 * WITHOUT loading the rest of frames.jsonl. Never throws: a missing file, a
 * first line that overruns the head budget, or a first line that doesn't
 * parse into the expected shape all resolve to `null` — honest absence,
 * never a guess.
 * @param {string} runDir
 * @returns {string | null} */
export function modelFromFramesHead(runDir) {
  return harnessFromFramesHead(runDir)?.model ?? null;
}

/** The whole seq-0 `harness` block, same bounded head-read, same
 * never-throws posture. Multiagent runs (2026-07-19) carry their walker
 * roster here (`harness.walkers: [{name, model}]`) in addition to `model`.
 * @param {string} runDir
 * @returns {{model?: string, walkers?: Array<{name: string, model: string}>} | null} */
export function harnessFromFramesHead(runDir) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return null;
  let fd;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    const line = buf.subarray(0, nl === -1 ? n : nl).toString("utf8");
    const frame = JSON.parse(line);
    return frame?.harness ?? null;
  } catch {
    return null; // malformed/missing/truncated first line: honest absence
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** listRuns()'s per-run `model` field: run.json's own value when the run
 * dissolved normally, else the seq-0 fallback above. `??` short-circuits —
 * the head-read only happens when run.json is absent or its `model` is
 * itself nullish, never for a run whose run.json already answered.
 * @param {{model?: string | null} | null} run
 * @param {string} runDir
 * @returns {string | null} */
export function resolveRunModel(run, runDir) {
  return run?.model ?? modelFromFramesHead(runDir);
}

/** listRuns()'s per-run `walkers` field (multiagent runs only): run.json's
 * roster when the run dissolved normally (there it also carries per-walker
 * turns/usage), else the seq-0 frame's name+model roster — a LIVE group
 * walk has no run.json yet, and the sidebar wants the joined names while
 * it's walking. Single-walker runs resolve null both ways: honest absence,
 * not a one-element pretense.
 * @param {{walkers?: Array<{name: string, model: string}> | null} | null} run
 * @param {string} runDir
 * @returns {Array<{name: string, model: string}> | null} */
export function resolveRunWalkers(run, runDir) {
  return run?.walkers ?? harnessFromFramesHead(runDir)?.walkers ?? null;
}

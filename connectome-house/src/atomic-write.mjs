// @ts-check
/* Atomic whole-file write (temp + rename): a reader never sees a torn file.
 * The one shape alarm-store.mjs, identity-map.mjs and blob-root.mjs share. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write `data` to `path` atomically: a sibling `<path>.tmp-<pid>-<rand>`
 * file is written first and renamed over the target, so a concurrent
 * reader always sees either the whole old content or the whole new one,
 * never a partial write. Creates the parent directory if needed; a failed
 * write removes its own tmp file rather than leaving litter.
 * @param {string} path
 * @param {string | Uint8Array} data */
export function atomicWriteFileSync(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The common case: a pretty-printed, newline-terminated JSON file, written
 * atomically. @param {string} path @param {any} value */
export function atomicWriteJSONSync(path, value) {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

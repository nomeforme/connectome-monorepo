// @ts-check
/* harness/src/mcpl/cursor.mjs — where a seat resumes tailing a room's
 * record. The cursor is never stored on its own: it is derived from the
 * sidecar's outbound rows, each of which names the speech frame's `seq`
 * it handled (delivered or refused). A room the seat has handled a frame
 * in resumes right after the last handled frame, so speech written while
 * the house was down is still carried; a room never handled from starts
 * at the end of the record — never replay what was said before the seat
 * first sat down. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** the highest `seq` any outbound row in the run's external.jsonl
 * carries, or null when none does
 * @param {string} runDir @returns {number|null} */
export function lastHandledSeq(runDir) {
  const p = join(runDir, "external.jsonl");
  if (!existsSync(p)) return null;
  let last = null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.direction === "out" && typeof r.seq === "number" && (last === null || r.seq > last))
        last = r.seq;
    } catch {
      /* a torn line is not a cursor */
    }
  }
  return last;
}

/** the byte offset to tail frames.jsonl from: after the last frame whose
 * seq ≤ the last handled one; the file's end when nothing was handled
 * (or there is no record yet)
 * @param {string} runDir @returns {number} */
export function tailOffsetFor(runDir) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return 0;
  const handled = lastHandledSeq(runDir);
  if (handled === null) return statSync(p).size;
  const text = readFileSync(p, "utf8");
  let offset = 0;
  let after = 0;
  for (const line of text.split("\n")) {
    const len = Buffer.byteLength(line, "utf8") + 1;
    if (line.trim()) {
      try {
        const seq = JSON.parse(line).seq;
        if (typeof seq === "number" && seq <= handled) after = offset + len;
      } catch {
        /* a torn line: the cursor does not move past it */
      }
    }
    offset += len;
  }
  return Math.min(after, statSync(p).size);
}

// @ts-check
// harness/src/mcpl/sweep.mjs — a channel's fetched history (seat start,
// every host reconnect) catches up messages this seat never saw.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routeIncoming } from "./route.mjs";

/** ids already in `runDir`'s external.jsonl, either direction.
 * @param {string} runDir @returns {Set<string>} */
export function recordedMessageIds(runDir) {
  const ids = new Set();
  const p = join(runDir, "external.jsonl");
  if (!existsSync(p)) return ids;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.message_id) ids.add(String(r.message_id));
    } catch {
      // a torn line names nothing
    }
  }
  return ids;
}

/** history messages not already recorded, oldest first, re-tagged so
 * routeIncoming does not drop them as decorative backscroll.
 * @param {import("./normalize.mjs").IncomingMessage[]} history
 * @param {Set<string>} recorded
 * @returns {import("./normalize.mjs").IncomingMessage[]} */
export function missedOf(history, recorded) {
  return history
    .filter((m) => !m.messageId || !recorded.has(String(m.messageId)))
    .sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""))
    .map((m) => ({ ...m, envelope: /** @type {const} */ ("incoming") }));
}

/** routeIncoming's own actions, forced record-only (placeholder default,
 * keeper's to change): no target ever activates from a missed message.
 * @param {any[]} actions @returns {any[]} */
export function observeOnly(actions) {
  return actions
    .filter((a) => a.kind !== "receipt")
    .map((a) => (a.kind === "input" ? { ...a, targets: [], observe: true, notice: undefined } : a));
}

/** the whole sweep for one channel's history: applies each missed
 * message through the seat's own `apply`, then names the count.
 * @param {{roomsOpen: (stream: string) => {id: string}|null,
 *   apply: (msg: any, actions: any[]) => Promise<void>,
 *   houseLine: (roomId: string, text: string) => void,
 *   say: (line: string) => void, RUNS: string, routeDeps: () => object}} deps
 * @param {string} stream @param {import("./normalize.mjs").IncomingMessage[]} history
 * @returns {Promise<number>} how many landed */
export async function sweepHistory(
  { roomsOpen, apply, houseLine, say, RUNS, routeDeps },
  stream,
  history,
) {
  const known = roomsOpen(stream);
  if (!known) return 0;
  const runDir = join(RUNS, known.id);
  const missed = missedOf(history, recordedMessageIds(runDir));
  let caught = 0;
  for (const msg of missed) {
    try {
      await apply(msg, observeOnly(routeIncoming({ ...routeDeps(), msg })));
      caught += 1;
    } catch (e) {
      say(`sweep of ${stream} could not record a missed message: ${e.message}`);
    }
  }
  if (caught)
    houseLine(
      known.id,
      `[caught up ${caught} missed message${caught === 1 ? "" : "s"} from ${stream} — recorded, not woken]`,
    );
  return caught;
}

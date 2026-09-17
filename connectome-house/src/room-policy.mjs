// @ts-check
/* harness/src/room-policy.mjs — the ontology (platform-reach R2c): every
 * run is a room; `class` names what happens in it and never renames for
 * this; a platform link is an optional PLACE (class.json.room), read here
 * at load time for any run, old or new, never rewritten. Standing follows
 * the place, not the class string — this replaces every hard-coded branch
 * on `class === "room"` in the harness. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beingsOf } from "./beings.mjs";
import { isPlatformRoom } from "./serve-identity.mjs";

/** a run dir's class.json, parsed. @param {string} runDir @returns {any} */
export function readCls(runDir) {
  return JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
}
/** write a run dir's class.json back, pretty-printed. @param {string} runDir @param {any} cls */
export function writeCls(runDir, cls) {
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls, null, 2));
}

/** the class.json.room stanza, or null. @param {any} cls @returns {any} */
export function placeOf(cls) {
  return isPlatformRoom(cls) ? cls.room : null;
}

/** has a place: never seals, exempt from the per-owner one-live-walk rule
 * — standing follows a room's place, not its class.
 * @param {any} cls @returns {boolean} */
export function isStanding(cls) {
  return !!placeOf(cls);
}

/** every class carries memory (a life loaded, a period appended) except
 * `sounding` — a bare probe of raw model behavior, deliberately memory-off.
 * @param {any} cls @returns {boolean} */
export function carriesMemory(cls) {
  return cls?.class !== "sounding";
}

/** the room facts for ANY run — place, beings, sessions — read straight
 * off its already-parsed class.json/run.json; a solo sounding sees none of
 * it, a Discord wondering sees all of it.
 * @param {any} cls @param {{sessions?: unknown[]}|null|undefined} run
 * @returns {{place: any, beings: string[], sessions: number}} */
export function roomOf(cls, run) {
  return { place: placeOf(cls), beings: beingsOf(cls), sessions: run?.sessions?.length ?? 0 };
}

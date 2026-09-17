// @ts-check
/* connectome-house/src/commands/store.mjs — where a command's own effect
 * persists, keyed the way 02-user-contract.md §2.1 documents (a mixed
 * three-tier scheme, kept mixed on purpose: "flattening is exactly the
 * kind of 'cleaner but different' change §7 warns against making
 * silently"): in-memory (this process only, lost on restart), per-room
 * (survives restart, keyed by room id, under the private root), and
 * global (keeper-scoped, under the private root, never keyed by room).
 *
 * Every write here is atomic (atomic-write.mjs's temp+rename), matching
 * every other persistence module in this package (identity-map.mjs,
 * testaments.mjs). `PRIVATE_DIR` is serve-paths.mjs's own root — this
 * module adds no root of its own, so a test's HOUSE_PRIVATE_DIR override
 * already sandboxes it. */
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJSONSync } from "../atomic-write.mjs";
import { PRIVATE_DIR } from "../serve-paths.mjs";

/** an in-memory tier: this process's own lifetime only, exactly what 00
 * §4.3 calls "most other commands" — a room key -> {command -> value} map,
 * or a single global bucket when `roomKey` is null (rr/bb's "axon-wide"). */
const memoryRoom = new Map();
const memoryGlobal = new Map();

/** test-only: drop every in-memory setting (a fresh process would start
 * here too — this lets one test file's rooms not bleed into another's). */
export function resetMemory() {
  memoryRoom.clear();
  memoryGlobal.clear();
}

/** a room id's filesystem-safe form — every character a real room key can
 * carry (`discord:<guild>:<chan>`, `signal:dm:<uuid>`, …) that isn't
 * `[a-zA-Z0-9._-]` becomes `_`; collisions are astronomically unlikely for
 * real room keys and, unlike a hash, this stays legible on disk. */
function safeRoomId(roomKey) {
  return String(roomKey ?? "global").replace(/[^a-zA-Z0-9._-]/g, "_");
}

const COMMANDS_ROOT = () => join(PRIVATE_DIR, "commands");
const ROOM_SETTINGS_DIR = () => join(COMMANDS_ROOT(), "rooms");
const GLOBAL_SETTINGS_PATH = () => join(COMMANDS_ROOT(), "global.json");
const SECRETS_DIR = () => join(COMMANDS_ROOT(), "secrets");

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** ---- memory tier ---- */
export function memoryGet(roomKey, key, fallback = undefined) {
  const bucket = roomKey == null ? memoryGlobal : memoryRoom.get(roomKey);
  if (!bucket || !bucket.has(key)) return fallback;
  return bucket.get(key);
}
export function memorySet(roomKey, key, value) {
  if (roomKey == null) {
    memoryGlobal.set(key, value);
    return;
  }
  const bucket = memoryRoom.get(roomKey) ?? new Map();
  bucket.set(key, value);
  memoryRoom.set(roomKey, bucket);
}

/** ---- per-room persisted tier: <private>/commands/rooms/<safeId>.json ---- */
export function roomSettingsPath(roomKey) {
  return join(ROOM_SETTINGS_DIR(), `${safeRoomId(roomKey)}.json`);
}
export function roomSettingsGet(roomKey, key, fallback = undefined) {
  const doc = readJSON(roomSettingsPath(roomKey), {});
  return Object.hasOwn(doc, key) ? doc[key] : fallback;
}
export function roomSettingsSet(roomKey, key, value) {
  const path = roomSettingsPath(roomKey);
  const doc = readJSON(path, {});
  doc[key] = value;
  atomicWriteJSONSync(path, doc);
  return doc;
}

/** ---- global persisted tier: <private>/commands/global.json ---- */
export function globalSettingsGet(key, fallback = undefined) {
  const doc = readJSON(GLOBAL_SETTINGS_PATH(), {});
  return Object.hasOwn(doc, key) ? doc[key] : fallback;
}
export function globalSettingsSet(key, value) {
  const path = GLOBAL_SETTINGS_PATH();
  const doc = readJSON(path, {});
  doc[key] = value;
  atomicWriteJSONSync(path, doc);
  return doc;
}

/** ---- secrets: 0600, one file per room (a room-scoped keeper vault),
 * value never returned by `list` (name + whether-set only), `get` is for
 * the house's own mount to read, never for a command reply to echo. ---- */
function secretsPath(roomKey) {
  return join(SECRETS_DIR(), `${safeRoomId(roomKey)}.json`);
}
export function secretSet(roomKey, name, value) {
  const path = secretsPath(roomKey);
  const doc = readJSON(path, {});
  doc[name] = value;
  atomicWriteJSONSync(path, doc);
  chmodSync(path, 0o600);
  // the containing dir need not be 0600 (other rooms' files already are),
  // but it should not be group/world-writable either
  try {
    chmodSync(SECRETS_DIR(), 0o700);
  } catch {}
}
export function secretGet(roomKey, name) {
  const doc = readJSON(secretsPath(roomKey), {});
  return Object.hasOwn(doc, name) ? doc[name] : undefined;
}
export function secretList(roomKey) {
  const doc = readJSON(secretsPath(roomKey), {});
  return Object.keys(doc).sort();
}
export function secretDelete(roomKey, name) {
  const path = secretsPath(roomKey);
  const doc = readJSON(path, {});
  const existed = Object.hasOwn(doc, name);
  delete doc[name];
  atomicWriteJSONSync(path, doc);
  chmodSync(path, 0o600);
  return existed;
}

/** harness-port R2-W, 2026-09-17 (mission task 1) — the ONE store consumer
 * this round wires: `!rr`/`!bb` (C2/C3) persist to the memory tier under
 * `dispatch.random_reply`/`dispatch.bot_mention_budget` (registry.mjs's
 * own `run`), axon-wide (roomKey null). This overlays whichever of those
 * two a keeper has actually SET onto a base dispatch object — the "next
 * decision that reads it" this task's brief names — leaving every other
 * field (mention/reply/dm/random_reply_suppressed_by_other_target/...)
 * exactly as the caller's own covenant already had it. Neither field is
 * overlaid when unset — a caller's own default (or its covenant's) rides
 * through unchanged, matching "in-memory, lost on restart" (00 §4.3):
 * nothing here invents a value nobody set.
 *
 * NAMED GAP (this task's own report, not silently skipped): `!mcf`/`!mmf`/
 * `!mt`/`!h-default`/`!split`/`!autotrigger`/`!sysprompt` all persist
 * already (registry.mjs, a prior round) but have NO consumer wired here
 * or anywhere else yet — this helper is deliberately narrow (rr/bb only,
 * the two this task's brief names explicitly), not a claim that the rest
 * are wired. Wiring THIS helper itself into a live covenant read
 * (resident-covenant.mjs's `roomPostureFor`, or seat.mjs's `routeDeps()`)
 * is also out of this task's owned files — see room-turn.mjs's own
 * "KNOWN GAP" note and this task's report for the matching seat.mjs seam.
 * @param {Record<string, any>} baseDispatch
 * @returns {Record<string, any>} */
export function applyCommandDispatchSettings(baseDispatch) {
  const rr = memoryGet(null, "dispatch.random_reply", undefined);
  const bb = memoryGet(null, "dispatch.bot_mention_budget", undefined);
  return {
    ...baseDispatch,
    ...(rr !== undefined ? { random_reply: rr } : {}),
    ...(bb !== undefined ? { bot_mention_budget: bb } : {}),
  };
}

/** test/ops helper: every settings file this module has ever written,
 * under the private root — used by a cleanup or an inspection, never by
 * command logic itself. Not exported for command handlers to call. */
export function _debugListFiles() {
  const out = [];
  for (const dir of [ROOM_SETTINGS_DIR(), SECRETS_DIR()]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) out.push(join(dir, f));
  }
  if (existsSync(GLOBAL_SETTINGS_PATH())) out.push(GLOBAL_SETTINGS_PATH());
  return out;
}

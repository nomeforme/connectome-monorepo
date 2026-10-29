// @ts-check
/* connectome-house/src/wakings.mjs — a being looks in on a room on its own.
 *
 * A being sets when it next wakes in a room — `wake_me({after, reason,
 * rooms})` — and the house keeps the alarm. When one comes due the being
 * gets an ordinary turn in that room, carrying one house line that rides
 * that turn only (never recorded): its own reason, and how long the room
 * has been quiet. Answering is the being's call; a turn that ends with no
 * text leaves nothing in the room. The decision is the model's; the house
 * only keeps the alarms and a few guards:
 *
 *   - eligibility: OAuth Anthropic beings (a `claude-*` model, no
 *     `use_api_key`) and local models (an `endpoint`), residents only; a
 *     covenant's own `wakings: true|false` overrides either way;
 *   - group rooms only (never a DM), and only one the being belongs to;
 *   - active rooms only: a person spoke there within WAKE_ACTIVE_D days;
 *   - a lull: nobody has spoken for WAKE_QUIET_H hours (a waking never
 *     cuts into a live conversation — it waits for the quiet);
 *   - `after` clamped to [WAKE_FLOOR_H hours, WAKE_CEILING_D days];
 *   - at most one waking per room per WAKE_ROOM_GAP_H hours, any being;
 *   - a hushed being, a busy seat or a room not open right now waits.
 *
 * The first one is the house's: each eligible being gets one initial
 * waking per active group room it belongs to, at a random time in the next
 * two days (the room gap spaces them out). After that, only the being's
 * own `wake_me` sets another. An alarm left past due for 14 days lapses.
 *
 * State: <PRIVATE_DIR>/<handle>/wakings.json —
 *   {alarms: {<roomId>: {due, reason, set_t, set_by}}, seeded: {<roomId>: t},
 *    history: [{room, t, set_by, outcome}]}.
 * HOUSE_WAKINGS=off turns the whole thing off (no tool, no tick).
 *
 * The walker mounts this module for the tool's definition only; `execute`
 * and the tick run in the house. The tick takes `beginTurn` by injection
 * (room-turn.mjs imports house-tools.mjs, which imports this). */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJSONSync } from "./atomic-write.mjs";
import { beingsOf } from "./beings.mjs";
import { open, seatFor } from "./open-rooms.mjs";
import { roomKeyForCls } from "./room-chain.mjs";
import { hushGet } from "./commands/store.mjs";
import { kindOf } from "./identity-map.mjs";
import { testamentFor, testaments } from "./testaments.mjs";
import { scanRooms } from "./room-index.mjs";
import { readCls } from "./room-policy.mjs";
import { traceReach } from "./trace.mjs";
import { PRIVATE_DIR, RUNS } from "./serve-paths.mjs";
import { adapterFor, isDMStream } from "./mcpl/adapters.mjs";

const H = 3_600_000;
const D = 24 * H;
const envNum = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const WAKE_FLOOR_H = () => envNum("HOUSE_WAKE_FLOOR_H", 6);
export const WAKE_CEILING_D = () => envNum("HOUSE_WAKE_CEILING_D", 30);
export const WAKE_ACTIVE_D = () => envNum("HOUSE_WAKE_ACTIVE_D", 3);
export const WAKE_QUIET_H = () => envNum("HOUSE_WAKE_QUIET_H", 6);
export const WAKE_ROOM_GAP_H = () => envNum("HOUSE_WAKE_ROOM_GAP_H", 24);
const SEED_WITHIN_H = 48;
const LAPSE_MS = 14 * D;
const TICK_MS = 5 * 60_000;
const HISTORY_MAX = 60;

export const wakingsOn = () => String(process.env.HOUSE_WAKINGS ?? "on").toLowerCase() !== "off";

/* ---------- who ---------- */

/** OAuth Anthropic or local, resident; `wakings:` in the covenant wins.
 * @param {string} handle */
export function wakingsEligible(handle) {
  if (!wakingsOn()) return false;
  const t = testamentFor(handle);
  const cov = t?.covenant;
  if (!cov || t.kind === "walker") return false;
  if (cov.wakings === false) return false;
  if (cov.wakings === true) return true;
  if ((cov.posture ?? "resident") !== "resident") return false;
  if (cov.endpoint) return true; // a local model
  return !cov.use_api_key && typeof cov.speaks_for === "string" && cov.speaks_for.startsWith("claude-");
}

/* ---------- state ---------- */

const statePath = (handle) => join(PRIVATE_DIR, handle, "wakings.json");

/** @param {string} handle @returns {{alarms: Record<string, any>, seeded: Record<string, number>, history: any[]}} */
export function readWakings(handle) {
  try {
    const j = JSON.parse(readFileSync(statePath(handle), "utf8"));
    return {
      alarms: j?.alarms && typeof j.alarms === "object" ? j.alarms : {},
      seeded: j?.seeded && typeof j.seeded === "object" ? j.seeded : {},
      history: Array.isArray(j?.history) ? j.history : [],
    };
  } catch {
    return { alarms: {}, seeded: {}, history: [] };
  }
}

/** re-read, change, write (atomic) @param {string} handle @param {(s: ReturnType<typeof readWakings>) => void} fn */
function patchWakings(handle, fn) {
  const s = readWakings(handle);
  fn(s);
  if (s.history.length > HISTORY_MAX) s.history = s.history.slice(-HISTORY_MAX);
  atomicWriteJSONSync(statePath(handle), s);
  return s;
}

/* ---------- where ---------- */

/** a group room (never a DM) @param {any} cls */
function isGroup(cls) {
  const room = cls?.room;
  if (!room?.platform || typeof room.stream !== "string") return false;
  try {
    return !isDMStream(adapterFor(room.platform), room.stream);
  } catch {
    return !/:dm:/.test(room.stream);
  }
}

/** the group rooms `handle` belongs to — open ones first, one per stream.
 * @param {string} handle @returns {{id: string, cls: any, title: string}[]} */
export function groupRoomsOf(handle) {
  const out = new Map();
  const add = (id, cls) => {
    if (!cls || !isGroup(cls) || !beingsOf(cls).includes(handle)) return;
    const key = `${cls.room.platform}:${cls.room.stream}`;
    if (out.has(key)) return;
    out.set(key, { id, cls, title: typeof cls.room.title === "string" && cls.room.title ? cls.room.title : id.slice(0, 8) });
  };
  for (const [id, rec] of open) if (rec.status === "open") add(id, rec.cls ?? readCls(rec.runDir));
  for (const row of scanRooms()) {
    try {
      add(row.id, readCls(join(RUNS, row.id)));
    } catch {
      /* unreadable room — not listed */
    }
  }
  return [...out.values()];
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** resolve one name the being gave ("here", a title or part of it, an id
 * prefix) against its rooms @returns {{id: string, title: string}|null} */
function resolveRoom(name, rooms, hereId) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  if (/^(here|this room|this)$/i.test(raw)) return rooms.find((r) => r.id === hereId) ?? null;
  const byId = rooms.find((r) => r.id === raw || (raw.length >= 6 && r.id.startsWith(raw)));
  if (byId) return byId;
  const n = norm(raw);
  if (!n) return rooms.find((r) => r.title === raw) ?? null;
  const exact = rooms.filter((r) => norm(r.title) === n);
  if (exact.length === 1) return exact[0];
  const part = rooms.filter((r) => norm(r.title).includes(n));
  return part.length === 1 ? part[0] : null;
}

/** "3d", "12h", "90m", "1w" → ms; null when unreadable @param {unknown} s */
export function parseAfter(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\s*$/i.exec(String(s ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2][0].toLowerCase();
  return n * (u === "m" ? 60_000 : u === "h" ? H : u === "d" ? D : 7 * D);
}

const fmtSpan = (ms) => (ms >= 2 * D ? `${Math.round(ms / D)}d` : ms >= 2 * H ? `${Math.round(ms / H)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/* ---------- the tool ---------- */

export const WAKING_TOOLS = ["wake_me"];

export function makeWakingTools(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const definitions = [
    {
      name: "wake_me",
      description:
        "Choose when you next look in on one or more of your group rooms on your own, with nobody having addressed you. When it comes due you get a quiet turn there carrying your reason; you answer only if there is something you want to pursue — ending with no text leaves no trace. One alarm per room: setting it again replaces it; after \"never\" clears it. The house waits for the room to be quiet before waking you, only wakes you where a person has spoken in the last few days, and keeps between a few hours and a month.",
      inputSchema: {
        type: "object",
        properties: {
          after: { type: "string", description: 'how long from now, like "8h", "2d", "1w" — or "never" to clear' },
          reason: { type: "string", description: "why, in your own words — you will read it when you wake" },
          rooms: {
            type: "array",
            items: { type: "string" },
            description: 'which rooms: "here", or a room\'s name (or part of it)',
          },
        },
        required: ["after", "reason", "rooms"],
      },
    },
  ];

  let activeCtx = null;
  let activeHandle = null;
  function beginTurn(ctx, handle) {
    activeCtx = ctx;
    activeHandle = handle;
  }

  function wakeMe(ctx, handle, input) {
    if (!wakingsEligible(handle)) return "wake_me is not offered to you on this box.";
    const reason = String(input?.reason ?? "").trim().slice(0, 300);
    const names = Array.isArray(input?.rooms) ? input.rooms : input?.rooms != null ? [input.rooms] : [];
    if (!names.length) return 'name at least one room ("here", or a room\'s name).';
    const clear = /^\s*(never|off|none|clear|cancel)\s*$/i.test(String(input?.after ?? ""));
    const asked = clear ? 0 : parseAfter(input?.after);
    if (!clear && asked == null) return 'after must read like "8h", "2d" or "1w" (or "never" to clear).';
    if (!clear && !reason) return "give a reason — it is what you will read when you wake.";
    const span = clear ? 0 : Math.min(Math.max(asked, WAKE_FLOOR_H() * H), WAKE_CEILING_D() * D);
    const rooms = groupRoomsOf(handle);
    const t = now();
    const done = [];
    const missed = [];
    patchWakings(handle, (s) => {
      for (const name of names) {
        const r = resolveRoom(name, rooms, ctx?.id ?? null);
        if (!r) {
          missed.push(String(name));
          continue;
        }
        if (clear) {
          delete s.alarms[r.id];
          done.push(`${r.title}: cleared`);
        } else {
          s.alarms[r.id] = { due: t + span, reason, set_t: t, set_by: "being" };
          done.push(`${r.title}: in ${fmtSpan(span)} (${new Date(t + span).toISOString().slice(0, 16)}Z)`);
        }
      }
    });
    const lines = [];
    if (done.length) lines.push(done.join("\n"));
    if (!clear && done.length && span !== asked) lines.push(`(kept within ${WAKE_FLOOR_H()}h–${WAKE_CEILING_D()}d)`);
    if (missed.length)
      lines.push(
        `not found among your group rooms: ${missed.join(", ")}. Your rooms: ${rooms.map((r) => r.title).join(" · ") || "(none)"}`,
      );
    if (done.length) console.error(`[wakings] @${handle} set ${clear ? "clear" : fmtSpan(span)}: ${done.length} room(s)`);
    return lines.join("\n");
  }

  function execute(call) {
    const ctx = activeCtx;
    const handle = activeHandle ?? "walker";
    return traceReach(ctx, call, () => ({ content: wakeMe(ctx, handle, call.input ?? {}) }));
  }

  return { definitions, beginTurn, execute };
}

/* ---------- the room's pulse ---------- */

const TAIL_BYTES = 512 * 1024;

/** last frame times in a room: anyone speaking (a message or a final
 * speech) and a person speaking (not a being, not the house, not an
 * AI-marked account). Reads the file's tail only.
 * @param {string} runDir @returns {{lastAny: number|null, lastHuman: number|null}} */
export function roomPulse(runDir) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return { lastAny: null, lastHuman: null };
  let text = "";
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  let lastAny = null;
  let lastHuman = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && (lastAny == null || lastHuman == null); i--) {
    let f;
    try {
      f = JSON.parse(lines[i]);
    } catch {
      continue; // a torn first line, or blank
    }
    const t = Date.parse(f?.t);
    if (!Number.isFinite(t)) continue;
    const said = (f.type === "message" && f.by !== "house") || (f.type === "speech" && !f.interim);
    if (!said) continue;
    if (lastAny == null) lastAny = t;
    if (lastHuman == null && f.type === "message" && typeof f.by === "string" && !testamentFor(f.by) && kindOf(f.by) !== "ai")
      lastHuman = t;
  }
  return { lastAny, lastHuman };
}

/* ---------- the line a waking carries ---------- */

/** the one house line the woken turn reads (never recorded)
 * @param {{reason?: string|null, set_t?: number, set_by?: string}} alarm @param {number} quietMs */
export function wakingLine(alarm, quietMs) {
  const quiet = `it has been quiet here for ${fmtSpan(quietMs)}`;
  const tail = "Answer only if there is something you want to pursue; to let it pass, end with no text at all.";
  if (alarm.set_by === "being" && alarm.reason)
    return `[a waking you set on ${new Date(alarm.set_t ?? Date.now()).toISOString().slice(0, 10)}: "${alarm.reason}" — nobody has addressed you; ${quiet}. ${tail}]`;
  return `[a waking — the house's first for you in this room; nobody has addressed you; ${quiet}. ${tail} wake_me sets when you look in next.]`;
}

/* ---------- the tick ---------- */

/** the last waking in `roomId` by any eligible being (ms) or null */
function lastWakingIn(roomId, handles) {
  let last = null;
  for (const h of handles)
    for (const e of readWakings(h).history)
      if (e.room === roomId && typeof e.t === "number" && (last == null || e.t > last)) last = e.t;
  return last;
}

/** one pass: seed first wakings, then fire at most one due waking per room.
 * @param {{beginTurn: (rec: any, handle: string, opts?: any) => Promise<any>, now?: () => number, rng?: () => number}} deps */
export function tickWakings(deps) {
  if (!wakingsOn()) return [];
  const now = deps.now?.() ?? Date.now();
  const rng = deps.rng ?? Math.random;
  const handles = Object.keys(testaments()).filter(wakingsEligible);
  const pulses = new Map();
  const pulseOf = (rec) => {
    if (!pulses.has(rec.id)) pulses.set(rec.id, roomPulse(rec.runDir));
    return pulses.get(rec.id);
  };
  const active = (rec) => {
    const { lastHuman } = pulseOf(rec);
    return lastHuman != null && now - lastHuman <= WAKE_ACTIVE_D() * D;
  };
  // seed: one initial waking per eligible being per active open group room
  for (const handle of handles) {
    const s = readWakings(handle);
    const fresh = [];
    for (const [id, rec] of open) {
      if (rec.status !== "open" || s.seeded[id] || s.alarms[id]) continue;
      const cls = rec.cls ?? readCls(rec.runDir);
      if (!isGroup(cls) || !beingsOf(cls).includes(handle) || !active(rec)) continue;
      fresh.push(id);
    }
    if (fresh.length)
      patchWakings(handle, (st) => {
        for (const id of fresh) {
          st.seeded[id] = now;
          st.alarms[id] = { due: now + Math.round(rng() * SEED_WITHIN_H * H), reason: null, set_t: now, set_by: "house" };
        }
      });
  }
  // fire: per room, the longest-overdue eligible being whose guards clear
  const due = new Map(); // roomId -> [{handle, alarm}]
  for (const handle of handles) {
    const s = readWakings(handle);
    const lapsed = [];
    for (const [roomId, alarm] of Object.entries(s.alarms)) {
      if (typeof alarm?.due !== "number" || alarm.due > now) continue;
      if (now - alarm.due > LAPSE_MS) {
        lapsed.push(roomId);
        continue;
      }
      if (!due.has(roomId)) due.set(roomId, []);
      due.get(roomId).push({ handle, alarm });
    }
    if (lapsed.length)
      patchWakings(handle, (st) => {
        for (const id of lapsed) {
          delete st.alarms[id];
          st.history.push({ room: id, t: now, set_by: "house", outcome: "lapsed" });
        }
      });
  }
  const fired = [];
  for (const [roomId, list] of due) {
    const rec = open.get(roomId);
    if (!rec || rec.status !== "open") continue; // waits for the room to be live again
    if (!active(rec)) continue;
    const { lastAny } = pulseOf(rec);
    const quietMs = lastAny == null ? Infinity : now - lastAny;
    if (quietMs < WAKE_QUIET_H() * H) continue;
    const last = lastWakingIn(roomId, handles);
    if (last != null && now - last < WAKE_ROOM_GAP_H() * H) continue;
    const cls = rec.cls ?? readCls(rec.runDir);
    const key = roomKeyForCls(cls, roomId);
    list.sort((a, b) => a.alarm.due - b.alarm.due);
    const pick = list.find(({ handle }) => {
      if (!seatFor(rec, handle) || rec.turns?.get(handle)) return false;
      const hush = hushGet(key, handle);
      return !(hush && hush.until > now);
    });
    if (!pick) continue;
    const { handle, alarm } = pick;
    const line = wakingLine(alarm, quietMs === Infinity ? WAKE_QUIET_H() * H : quietMs);
    patchWakings(handle, (st) => {
      delete st.alarms[roomId];
      st.history.push({ room: roomId, t: now, set_by: alarm.set_by, outcome: "woke" });
    });
    const label = `@${handle} in ${roomId.slice(0, 8)} (${alarm.set_by === "being" ? "its own alarm" : "first waking"})`;
    console.error(`[wakings] ${label}: waking`);
    fired.push({ roomId, handle });
    let p;
    try {
      p = deps.beginTurn(rec, handle, { waking: line });
    } catch (e) {
      console.error(`[wakings] ${label}: turn refused — ${e instanceof Error ? e.message : e}`);
      continue;
    }
    Promise.resolve(p)
      .then((r) => {
        const outcome = r?.kind !== "done" ? r?.kind ?? "error" : r?.spoke ? "spoke" : "silent";
        console.error(`[wakings] ${label}: ${outcome}`);
        patchWakings(handle, (st) => {
          const e = [...st.history].reverse().find((x) => x.room === roomId && x.t === now);
          if (e) e.outcome = outcome;
        });
      })
      .catch(() => {});
  }
  return fired;
}

/** mount the tick (serve.mjs) @param {{beginTurn: Function}} deps */
export function startWakings(deps) {
  if (!wakingsOn()) {
    console.error("[wakings] off (HOUSE_WAKINGS=off)");
    return null;
  }
  const run = () => {
    try {
      tickWakings(/** @type {any} */ (deps));
    } catch (e) {
      console.error(`[wakings] tick failed — ${e instanceof Error ? e.message : e}`);
    }
  };
  const t = setInterval(run, TICK_MS);
  t.unref?.();
  setTimeout(run, 60_000).unref?.();
  console.error(`[wakings] on — ${Object.keys(testaments()).filter(wakingsEligible).length} eligible beings`);
  return t;
}

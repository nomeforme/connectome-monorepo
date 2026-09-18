// @ts-check
/* connectome-house/src/mcpl/config-env.mjs — a servers-file room's
 * `stream` may carry `${NAME}` placeholders, expanded from the house's
 * own process.env at load (config.mjs's loadServersConfig calls this
 * before validateServer/validateGlobalRoom see the room). A comma-
 * separated env value fans a template out to one room per value,
 * cartesian across every placeholder it names; an unset or empty
 * variable drops that one room — logged by name, never a throw. */

const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** every distinct `${NAME}` in `template`, in first-appearance order.
 * @param {string} template @returns {string[]} */
export function placeholderNames(template) {
  const names = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** one `stream` template -> every expansion (cartesian over each
 * placeholder's comma-separated env value), or the first unset
 * variable's name when any placeholder resolves empty.
 * @param {string} template @param {Record<string,string|undefined>} env
 * @returns {{streams: string[]}|{unset: string}} */
export function expandStreamTemplate(template, env) {
  const names = placeholderNames(template);
  if (names.length === 0) return { streams: [template] };
  /** @type {Record<string,string[]>} */
  const values = {};
  for (const name of names) {
    const list = String(env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return { unset: name };
    values[name] = list;
  }
  let streams = [template];
  for (const name of names) {
    const next = [];
    for (const s of streams) for (const v of values[name]) next.push(s.split(`\${${name}}`).join(v));
    streams = next;
  }
  return { streams };
}

/** expand every room in a raw (global or per-server) `rooms[]` list
 * against `env`; a room whose template names an unset/empty variable is
 * dropped and logged (one line, by variable name) — every other room
 * passes through, expanded or (no placeholder) unchanged.
 * @param {any[]} rooms @param {Record<string,string|undefined>} env
 * @param {(msg: string) => void} [log] @returns {any[]} */
export function expandEnvRooms(rooms, env, log = (msg) => console.error(msg)) {
  const out = [];
  for (const r of rooms) {
    if (!r || typeof r.stream !== "string") {
      out.push(r);
      continue;
    }
    const result = expandStreamTemplate(r.stream, env);
    if ("unset" in result) {
      log(`mcpl config: room skipped — env var ${result.unset} is unset`);
      continue;
    }
    for (const stream of result.streams) out.push({ ...r, stream });
  }
  return out;
}

/** a raw SERVER entry -> the same entry with its own `rooms[]` (when an
 * array) run through `expandEnvRooms`; an entry with no rooms array (or
 * not an object) passes through unchanged.
 * @param {any} entry @param {Record<string,string|undefined>} env
 * @param {(msg: string) => void} [log] @returns {any} */
export function expandServerEnvRooms(entry, env, log) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.rooms)) return entry;
  return { ...entry, rooms: expandEnvRooms(entry.rooms, env, log) };
}

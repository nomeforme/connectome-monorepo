// @ts-check
/* connectome-house/src/house-tools.mjs — aggregates every being-facing
 * tool module this round ported (record/media/user-notes/stage/resident)
 * into ONE registry: `houseToolDefinitions()` for walk-turn.mjs's
 * `registerTools(defs)` (each definition is already `{name, description,
 * inputSchema}` — the exact shape that hook takes), and
 * `executeHouseTool(name, input, ctx, handle)` for room-turn.mjs's
 * `handleToolExec` to dispatch through. NOT wired into either file by
 * this module — room-turn.mjs is not an owned file this round; see this
 * round's report for the exact patch its `handleToolExec` needs
 * (specifically: skipping ITS OWN generic reach/reach.result append for
 * a house tool, since each module already frames its own via
 * `ctx.trace` — a double-write else).
 */
import { makeRecordTools } from "./record-tools.mjs";
import { makeMediaTools } from "./media-tools.mjs";
import { makeUserNotes } from "./user-notes.mjs";
import { makeStageTools } from "./stage-tools.mjs";
import { makeResidentTools } from "./resident-tools.mjs";
import { PRIVATE_DIR, RUNS } from "./serve-paths.mjs";

let mounted = null;

/** build every tool module once, deps resolved from the house's own
 * roots. `overrides.requestContinue`/`requestClose` are house-side
 * callbacks stage-tools.mjs/resident-tools.mjs each need and don't own
 * themselves — a caller (room-turn.mjs) supplies its own turn/close
 * machinery; omitted, both default to a no-op (safe for tests).
 * @param {{requestContinue?: Function, requestClose?: Function}} [overrides] */
export function mountHouseTools(overrides = {}) {
  const modules = [
    makeRecordTools({ runsRoot: RUNS }),
    makeMediaTools(),
    makeUserNotes({ privateRoot: PRIVATE_DIR, runsRoot: RUNS }),
    makeStageTools({ requestContinue: overrides.requestContinue ?? (() => {}) }),
    makeResidentTools({
      privateRoot: PRIVATE_DIR,
      runsRoot: RUNS,
      requestClose: overrides.requestClose ?? (() => {}),
    }),
  ];
  const byName = new Map();
  for (const m of modules) for (const d of m.definitions) byName.set(d.name, m);
  mounted = { modules, byName };
  return mounted;
}

/** every mounted tool's {name, description, inputSchema} — pass straight
 * to walk-turn.mjs's registerTools(defs). Mounts on first use if a caller
 * never called mountHouseTools() explicitly (tests: call it first, with
 * overrides). */
export function houseToolDefinitions() {
  if (!mounted) mountHouseTools();
  return mounted.modules.flatMap((m) => m.definitions);
}

/** true when `name` is a tool one of the mounted modules owns — the gate
 * room-turn.mjs's handleToolExec would check before falling to a
 * platform executor. */
export function isHouseTool(name) {
  if (!mounted) mountHouseTools();
  return mounted.byName.has(name);
}

/** dispatch one call to whichever module owns `name`; `{ok, content}`,
 * matching handleToolExec's own platform-executor contract. `ctx`/
 * `handle` pass straight to that module's own `beginTurn` (each module's
 * own header documents its ctx fields); `callId` is the SAME id
 * handleToolExec's own reach/reach.result pair already carries (a
 * module's internal traceReach pairs its own frame's `callId` against
 * it — see this file's own header on the double-write this implies). */
export async function executeHouseTool(name, input, ctx, handle, callId) {
  if (!mounted) mountHouseTools();
  const m = mounted.byName.get(name);
  if (!m) return { ok: false, content: `${name} is not offered here` };
  m.beginTurn(ctx, handle);
  const out = await m.execute({ id: callId, name, input });
  return { ok: !out.isError, content: out.content };
}

/** test-only: drop the mounted registry so a later mountHouseTools() with
 * fresh overrides/env isn't shadowed by an earlier call in the same
 * process. */
export function _resetHouseTools() {
  mounted = null;
}

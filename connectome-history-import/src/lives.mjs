// @ts-check
/* connectome-history-import/src/lives.mjs — each fleet being's life,
 * seeded from the rooms it lived: one `appendPeriod` per (being, imported
 * room), in the room's own order, through connectome-house's
 * `resident-life.mjs` (a public channel to the trunk, a private room to
 * the partition keyed by its other people, the owner's own room to the
 * trunk — the house's own routing, unchanged). `metadata.period.provenance:
 * "imported"` is stamped by `life-entries.mjs` from `class.json.imported`.
 * A being's trunk is opened here with `openLife` directly (not a registry
 * lookup that needs a covenant on this box): `speaksFor` is the testament's
 * voice when one exists, else "mock" — folding an imported life with a
 * real voice is real spend, and a keeper decision (the CLI's own `--real`
 * gate covers it — see cli.mjs).
 *
 * This module takes every house dependency by parameter (`life`, below) —
 * it imports no connectome-house module directly, so it's safe to import
 * statically from cli.mjs (see that file's import-order discipline).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{
 *   runsDir: string, privateRoot: string,
 *   rooms: Array<{id: string, beings: string[]}>,
 *   voiceFor: (handle: string) => Promise<{speaksFor: string, covenant: object, membrane: any}>,
 *   life: { openLife: Function, appendPeriod: Function, closeLife: Function, lifeStats: Function },
 *   log?: (line: string) => void,
 * }} args
 */
export async function seedLives({ runsDir, privateRoot, rooms, voiceFor, life, log = () => {} }) {
  /** @type {Map<string, string[]>} handle -> room ids, in id (chronological) order */
  const byBeing = new Map();
  for (const r of rooms)
    for (const h of r.beings) (byBeing.get(h) ?? byBeing.set(h, []).get(h)).push(r.id);
  const out = [];
  for (const [handle, ids] of [...byBeing.entries()].sort()) {
    const voice = await voiceFor(handle);
    const trunk = await life.openLife({
      privateRoot,
      handle,
      speaksFor: voice.speaksFor,
      covenant: voice.covenant,
      membrane: voice.membrane,
    });
    const modes = { trunk: 0, partition: 0, skip: 0, noop: 0, failed: 0 };
    const partitions = new Set();
    const failures = [];
    let messages = 0;
    for (const id of [...ids].sort()) {
      const runDir = join(runsDir, id);
      if (!existsSync(join(runDir, "class.json"))) continue;
      let res;
      try {
        res = await life.appendPeriod(trunk, runDir, { privateRoot });
      } catch (e) {
        // a room the life cannot take (a partition key past NAME_MAX for a
        // room with dozens of people, room-reach.mjs's partitionKey) is
        // reported, never fatal to the beings after it
        modes.failed += 1;
        failures.push({ id, error: String(e.message ?? e).slice(0, 160) });
        log(`  @${handle} ${id}: FAILED — ${String(e.message ?? e).slice(0, 160)}`);
        continue;
      }
      modes[res.mode] = (modes[res.mode] ?? 0) + 1;
      messages += res.messages;
      if (res.key) partitions.add(res.key);
      log(
        `  @${handle} ${id}: ${res.mode}${res.key ? ` (${res.key})` : ""} — ${res.messages} message(s)`,
      );
    }
    const stats = life.lifeStats(trunk);
    life.closeLife(trunk);
    out.push({
      handle,
      rooms: ids.length,
      messages,
      modes,
      partitions: partitions.size,
      stats,
      failures,
    });
  }
  return out;
}

/** which beings an imported room holds — its class.json `beings` */
export function roomBeings(runDir) {
  try {
    const cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    return Array.isArray(cls.beings) ? cls.beings : [];
  } catch {
    return [];
  }
}

#!/usr/bin/env node
/* Drain one being's life backlog NOW — the keeper's one-off (2026-10-17,
 * docs/harness-port/38). Run INSIDE the house container, from
 * /workspace/connectome-house, while the house is up:
 *
 *   node tools/drain-life.mjs <handle> [--ticks N] [--minutes M] [--clear-quarantine]
 *
 * It does not open the life itself: it asks the running house (POST
 * /api/house/<handle> {verb: "drain-life"} on loopback) to queue a life-job
 * `drain` on that handle's own job chain, so it never races the trunk's
 * lock with a compile or append the house is running. The house then
 * recompiles every room whose compiled life for the handle carries a note
 * (compiled over budget). Progress is in the house log:
 *
 *   docker compose --profile house logs -f house | grep '\[life'
 *
 * --ticks / --minutes bound the drain (defaults: HOUSE_LIFE_DRAIN_TICKS 48,
 * HOUSE_LIFE_DRAIN_MS 10 min — a big backlog may need --ticks 400
 * --minutes 120). --clear-quarantine first clears the compression-refusal
 * and merge quarantines (resident-life.mjs drainLife): use it when the
 * quarantines were recorded while the voice itself was broken. */
const args = process.argv.slice(2);
const handle = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
if (!handle) {
  console.error("usage: drain-life.mjs <handle> [--ticks N] [--minutes M] [--clear-quarantine]");
  process.exit(2);
}
const ticks = val("--ticks");
const minutes = val("--minutes");
const body = {
  verb: "drain-life",
  ...(ticks > 0 ? { maxTicks: ticks } : {}),
  ...(minutes > 0 ? { maxMs: Math.round(minutes * 60_000) } : {}),
  ...(args.includes("--clear-quarantine") ? { clearQuarantine: true } : {}),
};
const port = Number(process.env.HOUSE_PORT || 8787);
const r = await fetch(`http://127.0.0.1:${port}/api/house/${encodeURIComponent(handle)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await r.text();
console.log(r.status, text);
process.exit(r.ok ? 0 : 1);

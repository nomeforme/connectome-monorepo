// @ts-check
/* connectome-house/src/serve-retention.mjs — the keeper's two-step
 * retention sweep for external rooms (retention.mjs), over HTTP, inside
 * the house process (the only writer of the record, so a rewrite never
 * races an append):
 *
 *   GET  /api/retention                     what is past the retention now (no code)
 *   POST /api/retention {verb:"scan", days?} the same, plus a confirm code (30 min)
 *   POST /api/retention {verb:"purge", confirm} remove those words
 *
 * Keeper-only, like /api/house. And the daily reminder: one log line when
 * anything is past the retention, never more than once a day.
 */
import { open } from "./open-rooms.mjs";
import { proposeRetention, purgeRetention, retentionReminder, scanRetention } from "./retention.mjs";
import { RUNS } from "./serve-paths.mjs";
import { json } from "./serve-http.mjs";
import { whoAmI } from "./serve-identity.mjs";

const isOpen = (/** @type {string} */ runId) => open.has(runId);

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
export function handleRetentionGet(req, res) {
  if (!whoAmI(req).roles.includes("keeper")) return json(res, 403, { error: "retention is keeper-only" });
  const { code: _code, ...scan } = scanRetention({ runsDir: RUNS, isOpen });
  return json(res, 200, scan);
}

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
 * @param {(req: import("node:http").IncomingMessage) => Promise<any>} bodyReader */
export async function handleRetentionPost(req, res, bodyReader) {
  const who = whoAmI(req);
  if (!who.roles.includes("keeper")) return json(res, 403, { error: "retention is keeper-only" });
  const b = (await bodyReader(req)) ?? {};
  if (b.verb === "scan") {
    const days = Number.isInteger(b.days) && b.days > 0 ? b.days : undefined;
    const scan = proposeRetention({ runsDir: RUNS, isOpen, ...(days ? { days } : {}) });
    return json(res, 200, {
      ...scan,
      next: scan.total || scan.runs.length
        ? `to remove these, POST {"verb":"purge","confirm":"${scan.code}"} within 30 minutes`
        : "nothing to remove",
    });
  }
  if (b.verb === "purge") {
    if (typeof b.confirm !== "string") return json(res, 400, { error: "purge needs the confirm code from a scan" });
    const r = purgeRetention({ runsDir: RUNS, isOpen, confirm: b.confirm, by: who.handle });
    if (!r.ok) return json(res, 409, { error: r.error });
    console.error(`[retention] ${who.handle} removed ${r.removed} message(s) older than ${r.days} days from ${r.runs.length} external room(s)`);
    return json(res, 200, r);
  }
  return json(res, 400, { error: `unknown verb ${JSON.stringify(b.verb)}` });
}

/** check hourly; say so (once a day at most) when anything is due */
export function startRetentionReminder() {
  const tick = () => {
    try {
      const line = retentionReminder({ runsDir: RUNS, isOpen });
      if (line) console.error(`[retention] ${line}`);
    } catch (e) {
      console.error(`[retention] reminder check failed: ${/** @type {Error} */ (e).message}`);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}

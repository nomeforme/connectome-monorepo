// @ts-check
/* connectome-house/src/serve-shutdown.mjs — the house leaving on a signal
 * (SIGTERM/SIGINT/SIGHUP). Ported from a private deployment's
 * serve-shutdown.mjs, trimmed to this package's own surface: that source
 * rested every STANDING room (a corpus-composition concept, `room-policy.
 * mjs`'s `isStanding`, still present here) and reaped composed archive
 * mirrors (`serve-compose-mirror.mjs`, cut entirely from this port — see
 * connectome-house/README.md's "what was cut"). This port rests every
 * open room the same gentle way (`restRoom`, serve-rooms.mjs), stops
 * every house-spawned walker (`stopAllWalkers`, serve-walks.mjs — an
 * externally attached container is not this process's to stop; its own
 * seat simply goes quiet when the house closes), settles each present
 * being's own life-append, stops the MCPL seats, then exits — all
 * bounded, so a wedged child never holds the house hostage.
 *
 * Wiring is injected (same as the source) so the sequence is
 * unit-testable without signals; `serve.mjs` supplies the real deps. */
import { isStanding } from "./room-policy.mjs";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

/** @param {{open: Map<string, any>, restRoom: (rec: any) => Promise<unknown>,
 *   stopAllWalkers: () => Promise<unknown>, stopSeats: () => void,
 *   isStandingRoom?: (rec: any) => boolean,
 *   closeServer?: () => void, exit?: (code: number) => void, log?: (line: string) => void,
 *   roomTimeoutMs?: number, walkerTimeoutMs?: number}} deps */
export function createShutdown({
  open,
  restRoom,
  stopAllWalkers,
  stopSeats,
  // has a place, not a class (room-policy.mjs) — read fresh, never cached,
  // so this stays correct for a rec however (or whenever) it was created.
  isStandingRoom = (r) => isStanding(r.cls),
  closeServer = () => {},
  exit = (code) => process.exit(code),
  log = console.error,
  roomTimeoutMs = 5000,
  walkerTimeoutMs = 5000,
}) {
  let running = null;
  const bounded = (p, ms) =>
    Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]).catch((e) => {
      log(`[serve] shutdown step failed: ${e.message}`);
      return null;
    });

  /** @param {string} why */
  async function run(why) {
    const rooms = [...open.values()].filter((r) => isStandingRoom(r) && r.status === "open");
    log(`[serve] ${why}: resting ${rooms.length} open room(s), stopping ${stopAllWalkers ? "spawned walkers" : "nothing"}, then leaving`);
    // rest every open room first — a spawned walker still gets its own
    // gentle `close`/"rest" verb from stopAllWalkers below, but resting
    // the RECORD doesn't depend on that walker ever actually exiting.
    await bounded(
      Promise.all(rooms.map((rec) => restRoom(rec).catch((e) => log(`[serve] could not rest ${rec.id}: ${e.message}`)))),
      roomTimeoutMs,
    );
    await bounded(stopAllWalkers(), walkerTimeoutMs);
    stopSeats();
    closeServer();
    exit(0);
  }

  return {
    /** idempotent: a second signal while leaving is ignored */
    trigger(why) {
      running ??= run(why);
      return running;
    },
    install() {
      // a pty gone with the session makes stdio writes throw — never let that abort the leave
      for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
      for (const sig of SIGNALS) process.on(sig, () => void this.trigger(sig));
    },
  };
}

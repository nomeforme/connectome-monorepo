// @ts-check
/* connectome-house/src/walk-args.mjs — walker.mjs's own CLI-argument
 * surface: `--being <handle> --seat <unix:/path|tcp://host:port|stdio>
 * [--room <id>] [--max-concurrent <n>]`, plus a few per-turn sizing knobs.
 *
 * Reduced from the reference harness's walk-args.mjs (370 lines sizing a
 * whole CLI-spawned run: --surface/--walkers/--life-for/--resume/--tag/
 * --without/--follow-up — a run's own composition, obsolete once the
 * house renders each turn's context itself, room-turn.mjs): this port's
 * walker attaches to ONE being's ONE seat, seated to every room the house
 * finds it present in, and answers turns as they arrive, so its surface
 * is only enough to attach and to size a turn.
 *
 * harness-port W4-A, 2026-09-19: `--room` is now OPTIONAL for a socket
 * seat too (was required) — its presence still selects the legacy
 * single-room handshake mode a few tests keep (walk-e2e.test.mjs et al.);
 * its absence is the new default (one always-on walker per being, seated
 * wherever the house finds it present — see walker.mjs's own header).
 * `--max-concurrent` (default 1) caps how many rooms' turns this walker
 * runs at once — the fleet's own one-cycle-per-bot posture; a room whose
 * turn.begin arrives at the cap queues until a slot frees (walker.mjs's
 * own queue, not this file's job).
 *
 * harness-port W6-B, 2026-09-19: `--platforms <servers.json>` (or env
 * `HOUSE_PLATFORMS_FILE`) — this being now optionally hosts its own MCPL
 * platform children (platform-runner.mjs) beside the turn loop, on the
 * SAME seat connection. Absent, this walker is exactly what it was
 * before: no platform children, no behaviour change. */
const arg = (argv, n, d = null) => {
  const i = argv.indexOf(n);
  return i !== -1 ? argv[i + 1] : d;
};
const has = (argv, n) => argv.includes(n);

/** @param {string[]} argv */
export function parseWalkerArgs(argv) {
  const being = arg(argv, "--being");
  const seat = arg(argv, "--seat");
  if (!being || !seat) {
    console.error(
      "usage: walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>] [--max-concurrent <n>]",
    );
    process.exit(1);
  }
  const room = arg(argv, "--room", null);
  const mock = has(argv, "--mock") || process.env.HOUSE_MOCK_MODEL === "1";
  const maxTokens = Number(arg(argv, "--max-tokens", "16384"));
  const thinkArg = arg(argv, "--thinking", "off"); // fleet default: thinkingLevel ?? 'off' (connectome-agent.ts:212) — no bot sets it
  const thinking = mock || thinkArg === "off" ? undefined : { enabled: true, budgetTokens: Number(thinkArg) };
  const thinkingEffort = arg(argv, "--thinking-effort", "medium");
  const streamIdleMs = Number(arg(argv, "--stream-idle-ms", "45000"));
  const idleWatchdogMs = Number(arg(argv, "--idle-watchdog-ms", "90000"));
  const maxConcurrent = Math.max(1, Number(arg(argv, "--max-concurrent", "1")) || 1);
  const platformsFile = arg(argv, "--platforms", process.env.HOUSE_PLATFORMS_FILE || null);
  return {
    being,
    seat,
    room,
    mock,
    maxTokens,
    thinking,
    thinkingEffort,
    streamIdleMs,
    idleWatchdogMs,
    maxConcurrent,
    platformsFile,
  };
}

export { arg, has };

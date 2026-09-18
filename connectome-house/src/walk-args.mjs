// @ts-check
/* connectome-house/src/walk-args.mjs — walker.mjs's own CLI-argument
 * surface: `--being <handle> --seat <unix:/path|tcp://host:port|stdio>
 * [--room <id>]`, plus a few per-turn sizing knobs.
 *
 * Reduced from the reference harness's walk-args.mjs (370 lines sizing a
 * whole CLI-spawned run: --surface/--walkers/--life-for/--resume/--tag/
 * --without/--follow-up — a run's own composition, obsolete once the
 * house renders each turn's context itself, room-turn.mjs): this port's
 * walker attaches to ONE room's ONE seat and answers turns as they
 * arrive, so its surface is only enough to attach and to size a turn. */
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
    console.error("usage: walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>]");
    process.exit(1);
  }
  const room = arg(argv, "--room", null);
  const mock = has(argv, "--mock") || process.env.HOUSE_MOCK_MODEL === "1";
  const maxTokens = Number(arg(argv, "--max-tokens", "16384"));
  const thinkArg = arg(argv, "--thinking", "4096");
  const thinking = mock || thinkArg === "off" ? undefined : { enabled: true, budgetTokens: Number(thinkArg) };
  const thinkingEffort = arg(argv, "--thinking-effort", "medium");
  const streamIdleMs = Number(arg(argv, "--stream-idle-ms", "45000"));
  const idleWatchdogMs = Number(arg(argv, "--idle-watchdog-ms", "90000"));
  return { being, seat, room, mock, maxTokens, thinking, thinkingEffort, streamIdleMs, idleWatchdogMs };
}

export { arg, has };

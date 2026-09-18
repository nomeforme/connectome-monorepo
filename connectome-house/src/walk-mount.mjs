// @ts-check
/* connectome-house/src/walk-mount.mjs — shared capability-probe -> mount
 * contract for optional walker-side tool modules, so a registrant doesn't
 * hand-roll the "mounted ? X : []" conditional per module. Mounted =
 * named = capable: a tool that isn't reachable never appears in the
 * address or the wire tools array. Ported verbatim from the reference
 * harness (harness/src/walk-mount.mjs) — generic, no archive vocabulary. */

/** `probe()` (sync/async; pass `null` to skip and let `factory()` self-report
 * incapacity by returning null) gates the `factory()` call. */
export async function mountIfCapable(probe, factory) {
  if (probe && !(await probe())) return null;
  return factory();
}

/** the mounted tool's definitions, or none. */
export const defsIf = (mounted) => (mounted ? mounted.definitions : []);

/** the mounted tool's address fragment, or none; `address` overrides the
 * tool's own `.address` for modules that compose their own. */
export const addressIf = (mounted, address) => (mounted ? [address ?? mounted.address] : []);

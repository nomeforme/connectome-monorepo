// @ts-check
/* connectome-house/src/commands/grammar.mjs — text in, a parsed invocation
 * out; pure, no I/O, no knowledge of the registry (registry.mjs looks up
 * `name`, this module only recognizes the SHAPE of a line). Three shapes,
 * checked in this order because they overlap textually:
 *
 * 1. the continue trigger (02-user-contract.md C10, 00-stack-as-is.md
 *    §4.3): `!continue` or a bare `m continue|go|more` — handled even
 *    earlier than every other command in the fork (by the message
 *    receptor itself, before any `!`-dispatch runs at all) because it is
 *    not `!`-prefixed on its second form and must not be swallowed by the
 *    generic `!<name>` parse below.
 * 2. `!h<N> <text>` (C8): a one-shot context-trim directive glued directly
 *    to the digits with no space — `!h5 what do you think`, never
 *    `!h 5 …` — checked before the generic parser so `!h-default` (a
 *    literal, different command) and `!h<N>` never collide: the generic
 *    parser would read `!h5` as command name `h5` with no registry entry,
 *    so this dedicated check runs first and wins.
 * 3. the generic `!<name> [args]` shape every other command in
 *    02-user-contract.md §2 uses, WITH the fork's own argument-rebuild
 *    quirk reproduced verbatim (02 §2.1): both effectors rejoin
 *    `split(/\s+/).join(' ')` before parsing, so a multi-line argument
 *    (e.g. `!sysprompt override`'s <text>) loses its newlines here exactly
 *    as it does in the fork today — reproduced on purpose, not fixed
 *    silently, per 02 §2.1's own instruction. A keeper who learned to work
 *    around this with `file` mode is not carrying a workaround for a
 *    behaviour this port removed. NOTE: the fork's own escape hatch (a
 *    `file` argument mode reading an attachment instead of inline text)
 *    is NOT reproduced here — this module sees only text, never an
 *    attachment; a caller wanting `file` mode restored needs to thread an
 *    attachment through ctx, out of scope for this pure parser (see the
 *    package README's open gaps, and this task's own report). */

/** @typedef {{kind: "continue"} |
 *   {kind: "h-once", frames: number, text: string} |
 *   {kind: "bang", name: string, argsRaw: string}} ParsedCommand */

const CONTINUE_RE = /^(?:!continue|m\s+(?:continue|go|more))\s*$/i;
const H_ONCE_RE = /^!h(\d+)(?:\s+([\s\S]*))?$/i;
const BANG_RE = /^!([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;

/** the fork's own argument-rebuild quirk (02 §2.1): every internal run of
 * whitespace (including newlines) collapses to one space, and the whole
 * string is trimmed — reproduced verbatim, not fixed.
 * @param {string} s @returns {string} */
export function rebuildArgs(s) {
  return String(s ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
}

/** @param {string} text the message's own text, as the platform rendered it
 * (before mention-token rewriting — a command line has no mentions to
 * resolve) @returns {ParsedCommand|null} null when the text is not any
 * recognized command shape at all (an ordinary room turn) */
export function parseCommandLine(text) {
  const t = String(text ?? "");
  if (CONTINUE_RE.test(t.trim())) return { kind: "continue" };

  const hOnce = H_ONCE_RE.exec(t.trim());
  if (hOnce) {
    const frames = Number(hOnce[1]);
    return { kind: "h-once", frames, text: rebuildArgs(hOnce[2] ?? "") };
  }

  const bang = BANG_RE.exec(t.trim());
  if (!bang) return null;
  return { kind: "bang", name: bang[1].toLowerCase(), argsRaw: rebuildArgs(bang[2] ?? "") };
}

/** split a rebuilt argsRaw on single spaces (post-rebuild there are no
 * runs left to worry about) — the common case every command's own
 * `validate`/`run` wants instead of re-splitting argsRaw itself.
 * @param {string} argsRaw @returns {string[]} */
export function words(argsRaw) {
  const s = String(argsRaw ?? "").trim();
  return s ? s.split(" ") : [];
}

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
// parseCommandLine reads text with no leading mentions; callers strip them
// first with splitLeadingAddress (below).

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

/** a mention token, as a platform's raw text carries it: Discord `<@123>`/
 * `<@!123>`, Signal `<@uuid>`, the web board `<@kind:id>` */
const ID_TOKEN_RE = /^<@!?([A-Za-z0-9_.:-]+)>/;
/** Signal's own mention placeholder, should a raw body ever keep it */
const PLACEHOLDER = "￼";

/** @param {string} s */
export function normName(s) {
  return String(s ?? "").normalize("NFKC").toLowerCase();
}

/** the mentions a line opens with, and the text after them. Repeats over
 * `<@id>` tokens, U+FFFC placeholders (returned as `{id: "￼"}` — the
 * caller pairs them with the envelope's mention list in order), and
 * literal `@Name`: the longest known name (case-insensitive, NFKC) wins,
 * so a display name with spaces or homoglyphs matches whole; else `@\S+`.
 * Separators between mentions (spaces, commas, colons) are dropped.
 * @param {string} text @param {{names?: Iterable<string>}} [opts]
 * @returns {{address: Array<{id: string}|{name: string}>, rest: string}} */
export function splitLeadingAddress(text, { names = [] } = {}) {
  const known = [...new Set([...names].filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()))].sort(
    (a, b) => b.length - a.length,
  );
  /** @type {Array<{id: string}|{name: string}>} */
  const address = [];
  let t = String(text ?? "").replace(/^\s+/, "");
  for (;;) {
    const tok = ID_TOKEN_RE.exec(t);
    if (tok) {
      address.push({ id: tok[1] });
      t = t.slice(tok[0].length);
    } else if (t.startsWith(PLACEHOLDER)) {
      address.push({ id: PLACEHOLDER });
      t = t.slice(1);
    } else if (t.startsWith("@") && t.length > 1) {
      const after = t.slice(1);
      const lower = normName(after);
      const hit = known.find((n) => {
        const nn = normName(n);
        return lower.startsWith(nn) && !/[\p{L}\p{N}_-]/u.test(lower.charAt(nn.length));
      });
      if (hit) {
        // the matched span, measured on the original (NFKC can change lengths)
        let i = 1;
        while (i <= after.length && normName(after.slice(0, i)).length < normName(hit).length) i++;
        address.push({ name: after.slice(0, i) });
        t = after.slice(i);
      } else {
        const m = /^\S+/.exec(after);
        if (!m) break;
        address.push({ name: m[0].replace(/[,:;]+$/, "") });
        t = after.slice(m[0].length);
      }
    } else break;
    t = t.replace(/^[\s,:;]+/, "");
  }
  return { address, rest: t };
}

/** split a rebuilt argsRaw on single spaces (post-rebuild there are no
 * runs left to worry about) — the common case every command's own
 * `validate`/`run` wants instead of re-splitting argsRaw itself.
 * @param {string} argsRaw @returns {string[]} */
export function words(argsRaw) {
  const s = String(argsRaw ?? "").trim();
  return s ? s.split(" ") : [];
}
